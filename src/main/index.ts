import { isToggleInvocation, sendToggle } from './cli';

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
  const { openDatabase } = await import('./db/db');
  const { Repo } = await import('./db/repo');
  const { WindowManager, rendererEntry } = await import('./window');
  const { HotkeyManager } = await import('./hotkey');
  const { getPlatformAdapter } = await import('./platform');
  const { SessionManager } = await import('./agent/session');
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
  const { ProcessRegistry } = await import('./shell/process-registry');

  const SMART_RESUME_WINDOW_MS = 30 * 60 * 1000;

  // Prefer Wayland native rendering when available; fall back to X11.
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations,UseOzonePlatform');
  // Some Wayland compositors crash the GPU process on transparent windows; disable hw accel.
  app.disableHardwareAcceleration();

  await app.whenReady();

  let db;
  try {
    db = openDatabase(path.join(ottoConfigDir, 'otto.db'));
  } catch (err) {
    logger.error('failed to open database', err);
    dialog.showErrorBox('Otto', `Database open failed: ${err instanceof Error ? err.message : err}`);
    app.exit(1);
    return;
  }

  const repo = new Repo(db);
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

  // app.setLoginItemSettings is sync. On Linux it can be quirky depending on
  // the desktop environment; never let it tank app startup or block an IPC
  // handler by scheduling it off the current tick and swallowing errors.
  const applyStartAtLogin = (enabled: boolean) => {
    setImmediate(() => {
      try {
        app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
      } catch (err) {
        logger.warn(`setLoginItemSettings failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  };
  applyStartAtLogin(settings.getStartAtLogin());

  window.setPositionPref(settings.getWindowPosition());
  settings.onChange((snap) => {
    window.setPositionPref(snap.windowPosition);
  });

  let currentMessageId: string | null = null;

  // Intercept every session event so the Notifier can decide whether to
  // surface an OS notification (turn-complete / approval).
  const notifier = new Notifier({
    isMainFocused: () => window.isVisible() && window.isFocused(),
    showMain: () => window.show(window.getMode()),
    shouldNotifyTurnComplete: () => settings.getNotifications().turnComplete,
    shouldNotifyApproval: () => settings.getNotifications().approval,
    silent: () => !settings.getNotifications().sound,
  });
  const emitWithNotify: typeof emitSessionEvent = (event) => {
    notifier.handle(event);
    emitSessionEvent(event);
  };

  const broker = new DecisionBroker(settings.getMode(), emitWithNotify);

  const registry = new ProcessRegistry(
    emitWithNotify,
    (command, cwd) => platform.shell.spawnShell(command, cwd)
  );

  const sdk = createRealSdkClient({
    broker,
    currentMessageId: () => currentMessageId ?? '',
    getRegistry: () => registry,
    getConfigDir: () => ottoConfigDir,
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

  const preloadPath = path.join(app.getAppPath(), 'out', 'preload', 'index.js');
  window.create(preloadPath, rendererEntry());

  registerIpcHandlers({
    repo,
    sessions,
    window,
    broker,
    settings,
    registry,
    appVersion: app.getVersion(),
    applyStartAtLogin,
    openLogsDir: () => {
      void shell.openPath(ottoConfigDir);
    },
  });

  setupUpdaterIpc(() => BrowserWindow.getAllWindows());

  const onToggle = () => {
    const mode = shouldResume(repo, sessions) ? 'panel' : 'bar';
    window.toggle(mode);
  };

  const hotkey = new HotkeyManager(platform, onToggle);
  let hotkeyState: { registered: boolean; failureReason: string | null; usingExternalToggle?: boolean } = {
    registered: false,
    failureReason: null,
  };
  try {
    hotkeyState = await hotkey.register();
    if (!hotkeyState.registered && !hotkeyState.usingExternalToggle) {
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

  const settingsWindow = new SettingsWindowManager(preloadPath, rendererEntry());

  const tray = new TrayManager({
    onShow: () => {
      const mode = shouldResume(repo, sessions) ? 'panel' : 'bar';
      window.show(mode);
    },
    onOpenSettings: () => settingsWindow.show(),
    onQuit: () => app.quit(),
  });
  tray.start();

  app.on('window-all-closed', () => {
    // keep running in background; quit via tray/menu
  });

  app.on('before-quit', () => {
    disposeUpdater();
    hotkey.unregisterAll();
    void toggleServer.stop();
    void registry.killAll();
    tray.destroy();
    settingsWindow.destroy();
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
