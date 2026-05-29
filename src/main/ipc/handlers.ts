import { ipcMain } from 'electron';
import type { Repo } from '../db/repo';
import type { SessionManager } from '../agent/session';
import type { ConversationPolicy } from '../agent/conversation-policy';
import type { TopicShiftDetector } from '../agent/topic-shift-detector';
import type { WindowManager } from '../window';
import type { DecisionBroker } from '../autonomy/decision-broker';
import type { Settings } from '../autonomy/settings';
import type { ProcessRegistry } from '../shell/process-registry';
import type { ArtifactRepo } from '../db/artifact-repo';
import type { FactRepo } from '../db/fact-repo';
import type { MemorySearch } from '../memory/search';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  SessionStartArgs,
  SessionStartResult,
  SessionSendArgs,
  SessionCancelArgs,
  SessionInterruptArgs,
  SessionLoadArgs,
  SessionEnsureForSubmitArgs,
  SessionEnsureForSubmitResult,
  SettingsView,
  ShortcutInfoView,
  AppInfo,
  UploadsStageArgs,
  UploadsStageResult,
  UploadsDiscardArgs,
  TopicShiftEvaluateArgs,
  TopicShiftEvaluateResult,
  WindowMode,
} from '@shared/ipc-contract';
import type { AutonomyMode, Message, SessionMeta } from '@shared/messages';
import { emitAutonomyEvent } from './events';
import { logger } from '../logger';
import { gatherShortcutInfo, openKeyboardSettings } from '../shortcut';
import { instanceDisplayName, isDevInstance } from '../instance';
import type { HotkeyManager } from '../hotkey';
import type { RemoteModule } from '../remote';
import type { PairingStore } from '../remote/pairing-store';
import type { RemoteSettings } from '../remote/settings';
import type { RemoteCeilingChoice } from '@shared/ipc-contract';

export function registerIpcHandlers(deps: {
  repo: Repo;
  sessions: SessionManager;
  window: WindowManager;
  broker: DecisionBroker;
  settings: Settings;
  registry: ProcessRegistry;
  conversationPolicy: ConversationPolicy;
  topicShiftDetector: TopicShiftDetector;
  appVersion: string;
  recommendedChord: string;
  hotkey: HotkeyManager;
  artifactRepo: ArtifactRepo;
  factRepo: FactRepo;
  memorySearch: MemorySearch;
  configDir: string;
  applyStartAtLogin(enabled: boolean): void;
  openLogsDir(): void;
  remote?: {
    module: RemoteModule;
    pairing: PairingStore;
    settings: { get(): RemoteSettings; set(s: RemoteSettings): void };
    applyRemoteCeiling?: (c: RemoteCeilingChoice) => void;
  };
}): void {
  const { repo, sessions, window, broker, settings, registry, conversationPolicy, topicShiftDetector } = deps;

  ipcMain.handle('session.start', async (_e, args: SessionStartArgs): Promise<SessionStartResult> => {
    const result = await sessions.start(args);
    conversationPolicy.recordActivity();
    return result;
  });

  ipcMain.handle('session.send', async (_e, args: SessionSendArgs): Promise<void> => {
    await sessions.send(args);
  });

  ipcMain.handle('uploads.stage', async (_e, args: UploadsStageArgs): Promise<UploadsStageResult> => {
    const { saveUserUpload } = await import('../user-uploads/store');
    return saveUserUpload(Buffer.from(args.bytes), args.mimeType, args.sessionId, deps.configDir);
  });

  ipcMain.handle('uploads.discard', async (_e, args: UploadsDiscardArgs): Promise<void> => {
    // Security: only allow paths under <configDir>/user-uploads/<sessionId>/
    const expectedPrefix = path.join(deps.configDir, 'user-uploads', args.sessionId) + path.sep;
    if (!args.path.startsWith(expectedPrefix)) return;
    await fsp.rm(args.path, { force: true });
  });

  ipcMain.handle('session.cancel', async (_e, args: SessionCancelArgs): Promise<void> => {
    // Legacy channel kept for compatibility; routes to interrupt().
    await sessions.interrupt(args);
  });

  ipcMain.handle('session.interrupt', async (_e, args: SessionInterruptArgs): Promise<void> => {
    await sessions.interrupt(args);
  });

  ipcMain.handle('session.close', async (_e, args: { sessionId: string }): Promise<void> => {
    await sessions.close(args);
  });

  ipcMain.handle(
    'session.ensureForSubmit',
    async (
      _e,
      args: SessionEnsureForSubmitArgs,
    ): Promise<SessionEnsureForSubmitResult> => {
      // The renderer is authoritative about which session the user is in —
      // don't fall back to main's last-active id, which can be stale (e.g.
      // after the user abandons via /n).
      const current = args.current;
      if (!current) {
        const { sessionId } = await sessions.start({ model: args.model });
        conversationPolicy.recordActivity();
        return { sessionId, isNew: true, reason: 'no-session' };
      }
      if (conversationPolicy.shouldStartFresh()) {
        const { sessionId } = await sessions.start({ model: args.model });
        conversationPolicy.recordActivity();
        return { sessionId, isNew: true, reason: 'idle-timeout' };
      }
      conversationPolicy.recordActivity();
      return { sessionId: current, isNew: false, reason: 'reused' };
    },
  );

  ipcMain.handle(
    'topicShift.evaluate',
    async (
      _e,
      args: TopicShiftEvaluateArgs,
    ): Promise<TopicShiftEvaluateResult> => {
      return topicShiftDetector.evaluate(args.sessionId, args.newPrompt);
    },
  );

  ipcMain.handle('session.list', async (): Promise<SessionMeta[]> => {
    return repo.listSessions();
  });

  ipcMain.handle('session.load', async (_e, args: SessionLoadArgs): Promise<Message[]> => {
    return repo.loadMessages(args.sessionId);
  });

  ipcMain.handle('window.setMode', async (_e, args: { mode: WindowMode }): Promise<void> => {
    window.setMode(args.mode);
  });

  ipcMain.handle('window.hide', async (): Promise<void> => {
    window.hide();
  });

  ipcMain.handle(
    'window.cycleDisplay',
    async (_e, args: { direction: 'next' | 'prev' }): Promise<void> => {
      window.cycleDisplay(args.direction);
    }
  );

  ipcMain.handle(
    'autonomy.decide',
    async (
      _e,
      args: { decisionId: string; decision: 'approve' | 'approve-session' | 'deny' }
    ): Promise<void> => {
      broker.resolve(args.decisionId, args.decision);
    }
  );

  ipcMain.handle('autonomy.getMode', async (): Promise<AutonomyMode> => settings.getMode());

  ipcMain.handle('autonomy.setMode', async (_e, args: { mode: AutonomyMode }): Promise<void> => {
    try {
      await settings.setMode(args.mode);
    } catch (err) {
      logger.error('failed to set mode', err);
      emitAutonomyEvent({ type: 'mode-changed', mode: settings.getMode() });
      throw err;
    }
  });

  ipcMain.handle(
    'shell.kill',
    async (_e, args: { handle: string }): Promise<{ killed: boolean }> => {
      const killed = registry.kill(args.handle);
      return { killed };
    }
  );

  ipcMain.handle('settings.get', async (): Promise<SettingsView> => {
    const snap = settings.snapshot();
    return { ...snap, version: deps.appVersion };
  });

  ipcMain.handle(
    'settings.setNotifications',
    async (
      _e,
      args: Partial<{ turnComplete: boolean; approval: boolean; sound: boolean }>
    ): Promise<void> => {
      await settings.setNotifications(args);
    }
  );

  ipcMain.handle(
    'settings.setStartAtLogin',
    async (_e, args: { enabled: boolean }): Promise<void> => {
      await settings.setStartAtLogin(args.enabled);
      deps.applyStartAtLogin(args.enabled);
    }
  );

  ipcMain.handle(
    'settings.setWindowPosition',
    async (_e, args: { position: 'bottom-center' | 'top-center' }): Promise<void> => {
      await settings.setWindowPosition(args.position);
      // Re-position the visible window immediately so the change is felt.
      if (window.isVisible()) window.show(window.getMode());
    }
  );

  ipcMain.handle(
    'settings.setDisplayTarget',
    async (_e, args: { target: 'cursor' | 'primary' }): Promise<void> => {
      await settings.setDisplayTarget(args.target);
      if (window.isVisible()) window.show(window.getMode());
    }
  );

  ipcMain.handle(
    'settings.setAutoDeleteDays',
    async (_e, args: { days: number }): Promise<void> => {
      await settings.setAutoDeleteDays(args.days);
    }
  );

  ipcMain.handle(
    'settings.setHideOnBlur',
    async (_e, args: { enabled: boolean }): Promise<void> => {
      await settings.setHideOnBlur(args.enabled);
    }
  );

  ipcMain.handle(
    'settings.setNewConversationIdleTimeoutMinutes',
    async (_e, args: { minutes: number }): Promise<void> => {
      await settings.setNewConversationIdleTimeoutMinutes(args.minutes);
    }
  );

  ipcMain.handle('settings.openLogsDir', async (): Promise<void> => {
    deps.openLogsDir();
  });

  ipcMain.handle('settings.resetAllSessions', async (): Promise<{ deleted: number }> => {
    const deleted = repo.deleteAllSessions();
    const { wipeAllSessionFiles } = await import('../screenshot/cleanup');
    await wipeAllSessionFiles(path.join(deps.configDir, 'screenshots'));
    await wipeAllSessionFiles(path.join(deps.configDir, 'user-uploads'));
    return { deleted };
  });

  function shortcutInfo(): ShortcutInfoView {
    const info = gatherShortcutInfo({
      recommendedChord: deps.recommendedChord,
      friendlyName: instanceDisplayName(),
      hotkeyState: deps.hotkey.getState(),
    });
    return {
      desktopEnv: info.desktopEnv,
      displayServer: info.displayServer,
      mechanism: info.mechanism,
      registered: info.registered,
      recommendedChord: info.recommendedChord,
      friendlyName: info.friendlyName,
      commands: info.commands,
    };
  }

  ipcMain.handle('shortcut.info', async (): Promise<ShortcutInfoView> => shortcutInfo());

  ipcMain.handle('app.info', async (): Promise<AppInfo> => ({
    isDev: isDevInstance(),
    displayName: instanceDisplayName(),
    version: deps.appVersion,
  }));

  ipcMain.handle(
    'shortcut.openKeyboardSettings',
    async (): Promise<{ launched: boolean }> => {
      const launched = await openKeyboardSettings(shortcutInfo().desktopEnv);
      return { launched };
    }
  );

  ipcMain.handle('memory.list', async (_e, args: {
    kind: 'fact' | 'playbook' | 'anti_pattern' | 'heuristic';
    query?: string;
    includeArchived?: boolean;
  }) => {
    if (args.kind === 'fact') {
      if (args.query && args.query.trim()) {
        const out = await deps.memorySearch.search({ query: args.query, kinds: ['fact'], limit: 100 });
        return {
          artifacts: [],
          facts: out.facts.map((f) => ({ id: f.id, body: f.body, pinned: f.pinned, useCount: f.useCount, lastUsedAt: f.lastUsedAt })),
        };
      }
      const hits = deps.factRepo.list({ limit: 200 });
      return {
        artifacts: [],
        facts: hits.map((f) => ({ id: f.id, body: f.body, pinned: f.pinned, useCount: f.useCount, lastUsedAt: f.lastUsedAt })),
      };
    }
    if (args.query && args.query.trim()) {
      const out = await deps.memorySearch.search({ query: args.query, kinds: [args.kind], limit: 200 });
      return {
        artifacts: out.artifacts.map((r) => ({
          id: r.id, kind: r.kind, title: r.title, body: r.body, tags: r.tags,
          createdAt: r.createdAt, updatedAt: r.updatedAt, useCount: r.useCount,
          lastUsedAt: r.lastUsedAt, archived: r.archived,
        })),
        facts: [],
      };
    }
    const rows = deps.artifactRepo.list({ kind: args.kind, includeArchived: args.includeArchived });
    return {
      artifacts: rows.map((r) => ({
        id: r.id, kind: r.kind, title: r.title, body: r.body, tags: r.tags,
        createdAt: r.createdAt, updatedAt: r.updatedAt, useCount: r.useCount,
        lastUsedAt: r.lastUsedAt, archived: r.archived,
      })),
      facts: [],
    };
  });

  ipcMain.handle('memory.get', async (_e, args: { id: string }) => {
    const row = deps.artifactRepo.get(args.id);
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      tags: row.tags,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      useCount: row.useCount,
      lastUsedAt: row.lastUsedAt,
      archived: row.archived,
    };
  });

  ipcMain.handle(
    'memory.update',
    async (
      _e,
      args: {
        id: string;
        patch: { title?: string; body?: string; tags?: string[]; archived?: boolean };
      }
    ) => {
      await deps.artifactRepo.update(args.id, args.patch);
    }
  );

  ipcMain.handle('memory.delete', async (_e, args: { id: string }) => {
    deps.artifactRepo.delete(args.id);
  });

  ipcMain.handle('remoteDesktop.status', async (): Promise<{ granted: boolean }> => {
    const tokenPath = path.join(deps.configDir, 'remote-desktop-token');
    try {
      await fsp.access(tokenPath);
      return { granted: true };
    } catch {
      return { granted: false };
    }
  });

  ipcMain.handle('remoteDesktop.revoke', async (): Promise<void> => {
    const tokenPath = path.join(deps.configDir, 'remote-desktop-token');
    try {
      await fsp.unlink(tokenPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  });

  if (deps.remote) {
    const { module: mod, pairing, settings: remoteSettings, applyRemoteCeiling } = deps.remote;
    ipcMain.handle('remote:getStatus', () => {
      const s = mod.status();
      const cfg = remoteSettings.get();
      return { ...s, enabled: cfg.enabled, remoteCeiling: cfg.remoteCeiling };
    });
    ipcMain.handle('remote:setEnabled', async (_e, args: { enabled: boolean }) => {
      const cfg = remoteSettings.get();
      remoteSettings.set({ ...cfg, enabled: args.enabled });
      if (args.enabled) await mod.start();
      else await mod.stop();
    });
    ipcMain.handle(
      'remote:setRemoteCeiling',
      (_e, args: { ceiling: RemoteCeilingChoice }) => {
        const cfg = remoteSettings.get();
        remoteSettings.set({ ...cfg, remoteCeiling: args.ceiling });
        applyRemoteCeiling?.(args.ceiling);
      }
    );
    ipcMain.handle('remote:mintPairingCode', () => mod.mintPairingCode());
    ipcMain.handle('remote:listDevices', () => {
      return pairing
        .list()
        .filter((d) => !d.revokedAt)
        .map((d) => ({
          id: d.id,
          label: d.label,
          pairedAt: d.pairedAt,
          lastSeenAt: d.lastSeenAt,
        }));
    });
    ipcMain.handle('remote:revokeDevice', (_e, args: { deviceId: string }) => {
      pairing.revoke(args.deviceId);
    });
  }

  settings.onChange((snap) => {
    broker.setMode(snap.autonomy.mode);
    emitAutonomyEvent({ type: 'mode-changed', mode: snap.autonomy.mode });
  });

  logger.info('ipc handlers registered');
}
