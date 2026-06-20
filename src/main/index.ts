import { isToggleInvocation, sendToggle } from './cli';
import { newSystemMessage } from '@shared/messages';

// Handle `otto toggle` BEFORE any Electron initialization. The CLI path
// connects to the running instance's Unix socket, prints the response, and
// exits. It must not start Electron — otherwise we'd spawn a duplicate app.
if (isToggleInvocation()) {
  sendToggle()
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
} else {
  // Defer the rest of bootstrap to keep this branch obvious.
  void startElectron();
}

async function startElectron(): Promise<void> {
  const { app, dialog, shell, BrowserWindow } = await import('electron');
  const path = await import('node:path');
  const { logger, ottoConfigDir } = await import('./logger');
  const { isDevInstance, instanceDisplayName } = await import('./instance');

  // Give the dev build its own identity so it doesn't clobber the installed
  // prod build's userData (Chromium profile, IndexedDB, cookies, etc.).
  // Set this before app.whenReady() — Electron caches the userData path on
  // first access.
  if (isDevInstance()) {
    app.setName(instanceDisplayName());
    app.setPath('userData', path.join(app.getPath('appData'), instanceDisplayName()));
    logger.info(`running as ${instanceDisplayName()} — userData=${app.getPath('userData')}, configDir=${ottoConfigDir}`);
  }

  // Prevent a second Otto from spawning if the user double-launches the
  // AppImage / .desktop entry. Dev and prod use distinct app names (set
  // above) so each gets its own lock — they don't collide. If the lock is
  // already held, exit immediately; the first instance will surface itself
  // via the 'second-instance' handler below.
  if (!app.requestSingleInstanceLock()) {
    logger.info('another Otto instance is already running; exiting');
    app.exit(0);
    return;
  }
  const { openDatabase } = await import('./db/db');
  const { PrivacyAwareRepo } = await import('./db/privacy-aware-repo');
  const { WindowManager, rendererEntry } = await import('./window');
  const { HotkeyManager } = await import('./hotkey');
  const { getPlatformAdapter } = await import('./platform');
  const { SessionManager } = await import('./agent/session');
  const { ConversationPolicy } = await import('./agent/conversation-policy');
  const { TopicShiftDetector } = await import('./agent/topic-shift-detector');
  const { createRealSdkClient } = await import('./agent/sdk-client');
  const { registerIpcHandlers } = await import('./ipc/handlers');
  const { setupUpdaterIpc, disposeUpdater } = await import('./ipc/updater');
  const { emitSessionEvent } = await import('./ipc/events');
  const { ToggleServer } = await import('./toggle-server');
  const { TrayManager } = await import('./tray');
  const { SettingsWindowManager } = await import('./settings-window');
  const { Notifier } = await import('./notifier');
  const { Settings } = await import('./autonomy/settings');
  const { DecisionBroker } = await import('./autonomy/decision-broker');
  const { SudoBroker } = await import('./autonomy/sudo-broker');
  const { SudoSession } = await import('./shell/sudo-session');
  const { ProcessRegistry } = await import('./shell/process-registry');
  const { applyLinuxAutostart } = await import('./autostart-linux');
  const { OverlayManager } = await import('./overlay-window');
  const { ArtifactRepo } = await import('./db/artifact-repo');
  const { ReflectionPipeline } = await import('./reflection/pipeline');
  const { CompletionDetector } = await import('./reflection/completion-detector');
  const { FactRepo } = await import('./db/fact-repo');
  const { importLegacyKnowledge } = await import('./knowledge/import-legacy');
  const { cleanupDuplicateFacts } = await import('./knowledge/cleanup');
  const { regenerateKnowledgeFile, renderPinnedAsMarkdown } = await import('./knowledge/store');
  const { getEmbedder } = await import('./embeddings/embedder');
  const { backfillEmbeddings } = await import('./embeddings/backfill');
  const { MemorySearch } = await import('./memory/search');
  const { SessionBus } = await import('./remote/session-bus');
  const { RemoteModule } = await import('./remote');
  const { BridgeServer } = await import('./remote/bridge-server');
  const { PairingStore } = await import('./remote/pairing-store');
  const { resolveTailnetEndpoint } = await import('./remote/tailnet');
  const { loadRemoteSettings, saveRemoteSettings } = await import('./remote/settings');
  const { ImageCache } = await import('./image-cache/cache');
  const { registerImageProtocolPrivileges, registerImageProtocolHandler } = await import('./image-cache/protocol');
  const { registerOttoImageSchemePrivileges, registerOttoImageProtocol, registerOttoUserImageSchemePrivileges, registerOttoUserImageProtocol } = await import('./screenshot/protocol');
  const { randomBytes } = await import('node:crypto');

  registerImageProtocolPrivileges();
  registerOttoImageSchemePrivileges();
  registerOttoUserImageSchemePrivileges();

  const SMART_RESUME_WINDOW_MS = 30 * 60 * 1000;

  if (process.platform === 'linux') {
    // Prefer Wayland native rendering when available; fall back to X11.
    app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
    app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations,UseOzonePlatform');
    // Some Wayland compositors crash the GPU process on transparent windows; disable hw accel.
    app.disableHardwareAcceleration();
  }

  await app.whenReady();

  // Hide the dock icon on macOS — Otto is a tray/overlay app and the dock
  // entry only causes an unwanted bouncing icon when the window is shown.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  const imageCache = new ImageCache({ cacheDir: path.join(ottoConfigDir, 'image-cache') });
  registerImageProtocolHandler(imageCache);
  registerOttoImageProtocol(path.join(ottoConfigDir, 'screenshots'));
  registerOttoUserImageProtocol(path.join(ottoConfigDir, 'user-uploads'));

  let db;
  try {
    db = openDatabase(path.join(ottoConfigDir, 'otto.db'));
  } catch (err) {
    logger.error('failed to open database', err);
    dialog.showErrorBox('Otto', `Database open failed: ${err instanceof Error ? err.message : err}`);
    app.exit(1);
    return;
  }

  const repo = new PrivacyAwareRepo(db);
  const platform = getPlatformAdapter();
  const window = new WindowManager();

  const settings = new Settings(path.join(ottoConfigDir, 'settings.json'));
  await settings.load();

  // Apply auto-deletion of old sessions on startup. Cheap to run; no need to
  // schedule a recurring job — most users only launch Otto once per boot.
  const autoDeleteDays = settings.getAutoDeleteDays();
  if (autoDeleteDays > 0) {
    const cutoff = Date.now() - autoDeleteDays * 86400000;
    const removed = repo.deleteSessionsOlderThan(cutoff);
    if (removed > 0) logger.info(`auto-deleted ${removed} session(s) older than ${autoDeleteDays}d`);
  }

  // Non-blocking orphan session-file sweep: remove any session dirs that have
  // no corresponding session in the database (e.g. left over from a hard kill).
  void (async () => {
    try {
      const { sweepOrphanSessionFiles } = await import('./screenshot/cleanup');
      const sessions = repo.listSessions();
      const known = new Set(sessions.map((s: { id: string }) => s.id));
      await sweepOrphanSessionFiles(path.join(ottoConfigDir, 'screenshots'), known);
      await sweepOrphanSessionFiles(path.join(ottoConfigDir, 'user-uploads'), known);
    } catch (err) {
      console.warn('orphan session-file sweep failed', err);
    }
  })();

  // app.setLoginItemSettings is a no-op on Linux, so we write an XDG autostart
  // .desktop file there instead. Either path is scheduled off the current tick
  // and swallows errors so a quirky desktop environment can't tank startup or
  // block an IPC handler.
  const applyStartAtLogin = (enabled: boolean) => {
    setImmediate(() => {
      try {
        if (process.platform === 'linux') {
          applyLinuxAutostart(enabled);
        } else {
          app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
        }
      } catch (err) {
        logger.warn(`setLoginItemSettings failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  };
  applyStartAtLogin(settings.getStartAtLogin());

  window.setPositionPref(settings.getWindowPosition());
  window.setDisplayTarget(settings.getDisplayTarget());
  window.setHideOnBlur(settings.getHideOnBlur());
  window.setChatBounds(settings.getChatBounds());
  window.setLastVisibleMode(settings.getLastVisibleMode());
  settings.onChange((snap) => {
    window.setPositionPref(snap.windowPosition);
    window.setDisplayTarget(snap.displayTarget);
    window.setHideOnBlur(snap.hideOnBlur);
  });

  let currentMessageId: string | null = null;
  // Forward-declared so closures (emitWithNotify, reflection notifyLearned,
  // window.onVisibilityChange) can capture it before TrayManager is built.
  // eslint-disable-next-line prefer-const
  let tray: InstanceType<typeof TrayManager>;

  // Intercept every session event so the Notifier can decide whether to
  // surface an OS notification (turn-complete / approval).
  const notifier = new Notifier({
    isMainFocused: () => window.isVisible() && window.isFocused(),
    showMain: () => window.show(window.getMode()),
    shouldNotifyTurnComplete: () => settings.getNotifications().turnComplete,
    shouldNotifyApproval: () => settings.getNotifications().approval,
    silent: () => !settings.getNotifications().sound,
  });
  const overlay = new OverlayManager(
    path.join(app.getAppPath(), 'out', 'preload', 'index.js'),
    rendererEntry(),
    () => window.isVisible()
  );
  const sessionBus = new SessionBus();
  const baseEmit: typeof emitSessionEvent = (event) => {
    notifier.handle(event);
    overlay.handleSessionEvent(event);
    emitSessionEvent(event);
    // Badge the tray when a turn finishes while Otto is hidden — gives the
    // user an at-a-glance indicator that something's waiting without opening
    // the window. Cleared as soon as the main window becomes visible.
    if (event.type === 'done' && !window.isVisible()) {
      tray.setBadged(true);
    }
  };
  // Fan out to the SessionBus so remote subscribers (iPhone bridge) see the
  // same events as the renderer. Additive — preserves existing behavior.
  const emitWithNotify: typeof emitSessionEvent = (event) => {
    baseEmit(event);
    if ('sessionId' in event && typeof (event as { sessionId?: unknown }).sessionId === 'string') {
      sessionBus.publish(
        (event as { sessionId: string }).sessionId,
        { ...event, type: 'event', kind: event.type } as unknown as import('./remote/session-bus').RemoteOutbound
      );
    }
  };

  const broker = new DecisionBroker(settings.getMode(), emitWithNotify);
  const sudoSession = new SudoSession({ logger });
  const sudoBroker = new SudoBroker(sudoSession, emitWithNotify);

  const registry = new ProcessRegistry(
    emitWithNotify,
    (command, cwd) => platform.shell.spawnShell(command, cwd)
  );

  const embedder = getEmbedder();
  const artifactRepo = new ArtifactRepo(db, undefined, embedder);

  const factRepo = new FactRepo(db, undefined, embedder);
  try {
    await importLegacyKnowledge(ottoConfigDir, factRepo);
  } catch (err) {
    logger.error('importLegacyKnowledge failed', err);
  }
  try {
    cleanupDuplicateFacts(db, factRepo);
  } catch (err) {
    logger.error('cleanupDuplicateFacts failed', err);
  }
  await backfillEmbeddings({ db, embedder });
  factRepo.rerank();
  void regenerateKnowledgeFile(ottoConfigDir, factRepo);

  const memorySearch = new MemorySearch({ factRepo, artifactRepo, embedder, db });

  async function runReflectorSdk(prompt: string, opts: { model?: string; signal?: AbortSignal }): Promise<string> {
    const sdkMod = await import('@anthropic-ai/claude-agent-sdk');
    const { getSdkSpawnOverrides } = await import('./agent/sdk-client');
    const ac = new AbortController();
    // Propagate the external abort signal (e.g. from the reflector timeout).
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    // In packaged builds we must tell the SDK where claude-agent-sdk's cli.js
    // lives and spawn Electron-as-node — the AppImage has no `node`/`claude`
    // on PATH. Without this the subprocess exits with code 1 immediately.
    const spawnOverrides = getSdkSpawnOverrides();
    const iter = sdkMod.query({
      prompt,
      options: {
        model: opts.model ?? 'claude-haiku-4-5-20251001',
        systemPrompt:
          'You are Otto\'s reflection step. Output ONLY the JSON object requested by the user prompt — no prose, no markdown fences, no commentary.',
        tools: [],
        allowedTools: [],
        mcpServers: {},
        abortController: ac,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        maxTurns: 1,
        ...(spawnOverrides ?? {}),
      },
    });
    const chunks: string[] = [];
    for await (const msg of iter) {
      const m = msg as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
      if (m.type === 'assistant') {
        for (const block of m.message?.content ?? []) {
          if (block.type === 'text' && typeof block.text === 'string') chunks.push(block.text);
        }
      }
    }
    return chunks.join('');
  }

  const { reflect } = await import('./reflection/reflector');

  const pipeline = new ReflectionPipeline({
    repo,
    artifactRepo,
    factRepo,
    configDir: ottoConfigDir,
    isPrivate: (sessionId) => repo.isPrivate(sessionId),
    runReflector: (prompt) =>
      reflect({
        sdk: { run: async (p, opts) => runReflectorSdk(p, opts) },
        prompt,
        timeoutMs: 60_000,
      }),
    appendSystemNote: (sessionId, block) => {
      const msg = repo.appendMessage({
        ...newSystemMessage([block]),
        sessionId,
      });
      emitWithNotify({ type: 'system-message', sessionId, message: msg });
    },
  });

  const detector = new CompletionDetector({
    idleMs: 90_000,
    onTrigger: ({ sessionId, sinceSeq }) => {
      void (async () => {
        try {
          logger.info(`reflection triggered for session=${sessionId} sinceSeq=${sinceSeq}`);
          const result = await pipeline.run({ sessionId, sinceSeq });
          if (result.skipped) {
            logger.info(`reflection skipped: ${result.reason}`);
          } else {
            logger.info(`reflection complete: ${result.savedFacts} facts, ${result.savedArtifacts} artifacts`);
          }
          const msgs = repo.loadMessages(sessionId);
          const lastSeq = msgs.length > 0 ? msgs[msgs.length - 1]!.seq : sinceSeq;
          detector.notePersistedSeq(sessionId, lastSeq);
          await regenerateKnowledgeFile(ottoConfigDir, factRepo);
        } catch (err) {
          logger.error('reflection pipeline threw', err);
        }
      })();
    },
  });

  const sdk = createRealSdkClient({
    broker,
    sudo: sudoBroker,
    currentMessageId: () => currentMessageId ?? '',
    getRegistry: () => registry,
    getConfigDir: () => ottoConfigDir,
    recall: async (args) => {
      const limit = Math.min(args.limit ?? 5, 20);
      const out = await memorySearch.search({ query: args.query, kinds: args.kinds, limit });
      const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString().slice(0, 10));
      return {
        // Provenance lets the model weigh trust: a fact reused across many
        // sessions yesterday beats one learned months ago and never touched.
        facts: out.facts.map((f) => ({
          body: f.body,
          learned_at: iso(f.createdAt)!,
          last_used_at: iso(f.lastUsedAt),
          times_used: f.useCount,
          sessions_seen: f.distinctSessions,
        })),
        artifacts: out.artifacts.map((r) => ({
          id: r.id,
          kind: r.kind,
          title: r.title,
          body: r.body,
          tags: r.tags,
          updated_at: r.updatedAt,
          times_used: r.useCount,
          last_used_at: iso(r.lastUsedAt),
        })),
      };
    },
    memoryCounts: () => ({ ...artifactRepo.counts(), factsPinned: factRepo.counts().pinned, factsTotal: factRepo.counts().total }),
    factsForPrompt: () => {
      const pinned = factRepo.listPinned();
      return {
        markdown: renderPinnedAsMarkdown(factRepo),
        ids: pinned.map((f) => f.id),
      };
    },
    bumpFactUse: (ids, sessionId) => {
      if (repo.isPrivate(sessionId)) return;
      factRepo.bumpUse(ids, sessionId);
    },
    appendKnowledge: async (note, sessionId) => {
      if (repo.isPrivate(sessionId)) return; // private convos never write durable memory
      await factRepo.upsert({ body: note, preference: true, sourceSessionId: sessionId });
      factRepo.rerank();
      await regenerateKnowledgeFile(ottoConfigDir, factRepo);
    },
    onMarkTaskComplete: (sessionId, _summary) => {
      detector.onMarkComplete(sessionId);
    },
  });
  const sessions = new SessionManager(
    repo,
    sdk,
    'claude-sonnet-4-6',
    emitWithNotify,
    (id) => {
      currentMessageId = id;
    }
  );

  sessions.onDoneListener((sessionId) => detector.onDone(sessionId));
  sessions.onUserActiveListener((sessionId) => detector.onUserActive(sessionId));

  const conversationPolicy = new ConversationPolicy({
    now: () => Date.now(),
    getIdleTimeoutMinutes: () => settings.getNewConversationIdleTimeoutMinutes(),
  });
  sessions.onActivityListener(() => conversationPolicy.recordActivity());

  const topicShiftDetector = new TopicShiftDetector({
    repo,
    embedder: getEmbedder(),
  });
  // Remote (iPhone) inputs no longer route through the bus input queue —
  // BridgeServer now invokes sendPrompt/interruptTurn callbacks directly
  // (see the makeBridge factory below). The bus stays as the output fan-out
  // channel only.

  // Remote (iPhone) bridge supervisor. Always starts in Task 19; conditional
  // gating on settings lands in Task 22. Stays dormant until Tailscale is up.
  const pairingStore = new PairingStore(db);
  const screenshotSecret = randomBytes(32).toString('base64url');
  const remoteModule = new RemoteModule({
    pairing: pairingStore,
    bus: sessionBus,
    resolveTailnetEndpoint,
    makeBridge: (tailnetIp, tailnetHost) => new BridgeServer({
      tailnetIp,
      tailnetHost,
      port: 17829,
      // Tailnet is already an authenticated overlay network, and self-signed
      // HTTPS causes desktop browsers to silently reject the WSS handshake
      // (and rotates on every restart, invalidating any cert exception users
      // accept). Default to plain HTTP on the tailnet; set OTTO_REMOTE_HTTPS=1
      // to opt back into self-signed TLS. OTTO_DEV_HTTP=1 additionally binds
      // to 0.0.0.0 and exposes /dev/mint for the iOS simulator.
      plainHttp: !process.env.OTTO_REMOTE_HTTPS,
      devEndpoints: !!process.env.OTTO_DEV_HTTP,
      pairing: pairingStore,
      bus: sessionBus,
      pwaDir: path.join(app.getAppPath(), 'out', 'renderer-remote'),
      screenshotSecret,
      // Screenshot fan-out into the remote bus isn't wired yet (no caller
      // currently emits `screenshot-captured` events with a stable id), so the
      // /screenshot/<id> route has no source of truth to read from. Leaving as
      // a null stub means the route returns 404 if hit early; once the bus
      // fan-out lands, this becomes a read from src/main/screenshot/store.
      loadScreenshot: async () => null,
      imageCache,
      activeSessionId: () => sessions.getActiveSessionId(),
      resolveApproval: (id, choice) => { broker.resolve(id, choice); return true; },
      resolveSudo: (promptId, password) => { sudoBroker.resolveSudo(promptId, password); return true; },
      configDir: ottoConfigDir,
      sendPrompt: async (text, _origin, attachments) => {
        // Errors here used to be swallowed by the bridge's fire-and-forget
        // `void sendPrompt(...)`. The PWA had already optimistically flipped
        // streaming=true and would wait forever for a 'done' event that never
        // arrived. Surface failures via the bus so the phone can unjam and
        // show a useful error.
        let sid: string | null = sessions.getActiveSessionId();
        try {
          if (!sid) {
            const started = await sessions.start({});
            sid = started.sessionId;
          }
          await sessions.send({ sessionId: sid, text, attachments: attachments.length > 0 ? attachments : undefined });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`remote sendPrompt failed: ${msg}`);
          const target = sid ?? 'no-session';
          sessionBus.publish(target, { type: 'event', kind: 'done', sessionId: target } as unknown as import('./remote/session-bus').RemoteOutbound);
          sessionBus.publish(target, { type: 'error', code: 'send-failed', message: msg, fatal: false });
        }
      },
      interruptTurn: (sid) => {
        const target = sid ?? sessions.getActiveSessionId();
        if (target) void sessions.interrupt({ sessionId: target });
      },
      listSessions: async (limit) => repo.listSessions(limit),
      loadMessages: async (sessionId) => repo.loadMessages(sessionId),
      switchSession: async (sessionId) => { await sessions.start({ resume: sessionId }); },
      newSession: async () => {
        const r = await sessions.start({});
        return r.sessionId;
      },
    }),
  });
  // Load remote (iPhone bridge) settings from disk. Conditional start replaces
  // the unconditional Task 19 behavior: the user's saved preference governs
  // whether the bridge supervisor runs at boot, and the saved remoteCeiling is
  // applied to the autonomy broker.
  const remoteSettingsPath = path.join(ottoConfigDir, 'remote-settings.json');
  let remoteSettingsCache = loadRemoteSettings(remoteSettingsPath);
  const remoteSettingsWrap = {
    get: () => remoteSettingsCache,
    set: (s: import('./remote/settings').RemoteSettings) => {
      remoteSettingsCache = s;
      saveRemoteSettings(remoteSettingsPath, s);
    },
  };
  broker.setRemoteCeiling(remoteSettingsCache.remoteCeiling);
  if (remoteSettingsCache.enabled) void remoteModule.start();

  const preloadPath = path.join(app.getAppPath(), 'out', 'preload', 'index.js');
  window.create(preloadPath, rendererEntry());
  overlay.start();
  window.onChatBoundsChanged((b) => {
    void settings.setChatBounds(b);
  });
  window.onVisibilityChange((visible) => {
    if (visible) void settings.setLastVisibleMode(window.getMode());
    overlay.setMainVisible(visible);
    // Showing the main window counts as the user acknowledging any pending
    // turn-complete notification — clear the tray badge.
    if (visible) tray.setBadged(false);
  });

  const onToggle = () => {
    if (window.isVisible()) {
      window.hide();
      return;
    }
    // Resume the user's current tier rather than second-guessing it. The only
    // exception is cold-start: window has never been shown and there's an
    // active session — auto-promote bar → panel so the conversation is visible.
    const current = window.getMode();
    const mode =
      !window.hasBeenShown() && current === 'bar' && shouldResume(repo, sessions)
        ? 'panel'
        : current;
    window.show(mode);
  };

  const hotkey = new HotkeyManager(platform, onToggle, ottoConfigDir);

  const settingsWindow = new SettingsWindowManager(preloadPath, rendererEntry());

  registerIpcHandlers({
    repo,
    sessions,
    window,
    broker,
    sudoBroker,
    sudoSession,
    settings,
    registry,
    conversationPolicy,
    topicShiftDetector,
    appVersion: app.getVersion(),
    recommendedChord: platform.defaultHotkey(),
    hotkey,
    artifactRepo,
    factRepo,
    memorySearch,
    configDir: ottoConfigDir,
    applyStartAtLogin,
    openLogsDir: () => {
      void shell.openPath(ottoConfigDir);
    },
    openSettingsWindow: () => settingsWindow.show(),
    remote: {
      module: remoteModule,
      pairing: pairingStore,
      settings: remoteSettingsWrap,
      applyRemoteCeiling: (c) => broker.setRemoteCeiling(c),
    },
  });

  setupUpdaterIpc(() => BrowserWindow.getAllWindows(), notifier);

  let hotkeyState = hotkey.getState();
  try {
    hotkeyState = await hotkey.register();
    if (!hotkeyState.registered && hotkeyState.mechanism !== 'external-toggle') {
      logger.warn(`hotkey not registered: ${hotkeyState.failureReason}`);
    }
  } catch (err) {
    logger.warn(`hotkey registration threw: ${err instanceof Error ? err.message : err}`);
  }

  // The toggle server is always started: on Wayland it is the only trigger;
  // on X11 it provides a useful escape hatch (`otto toggle` from a terminal)
  // alongside the globalShortcut binding.
  const toggleServer = new ToggleServer(onToggle);
  try {
    await toggleServer.start();
  } catch (err) {
    logger.warn(`toggle server failed to start: ${err instanceof Error ? err.message : err}`);
  }

  tray = new TrayManager({
    onShow: () => {
      const current = window.getMode();
      const mode =
        !window.hasBeenShown() && current === 'bar' && shouldResume(repo, sessions)
          ? 'panel'
          : current;
      window.show(mode);
    },
    onOpenSettings: () => settingsWindow.show(),
    onQuit: () => app.quit(),
  });
  tray.start();

  app.on('window-all-closed', () => {
    // keep running in background; quit via tray/menu
  });

  // Triggered when the user double-launches Otto (e.g. clicks the AppImage
  // a second time). Treat the duplicate launch as a toggle so the user gets
  // an immediate response, the same way the CLI's `otto toggle` would.
  app.on('second-instance', (_e, argv) => {
    logger.info(`second-instance launch — argv=${JSON.stringify(argv)}; toggling main window`);
    onToggle();
  });

  app.on('before-quit', () => {
    disposeUpdater();
    hotkey.unregisterAll();
    void toggleServer.stop();
    void registry.killAll();
    void remoteModule.stop();
    tray.destroy();
    settingsWindow.destroy();
    overlay.destroy();
    db.close();
  });

  process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', reason));
  process.on('uncaughtException', (err) => logger.error('uncaughtException', err));

  function shouldResume(repo: import('./db/repo').Repo, sessions: import('./agent/session').SessionManager): boolean {
    const active = sessions.getActiveSessionId();
    if (!active) return false;
    const meta = repo.getSession(active);
    if (!meta) return false;
    return meta.status === 'active' || Date.now() - meta.lastActive < SMART_RESUME_WINDOW_MS;
  }
}
