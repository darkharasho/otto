import { ipcMain } from 'electron';
import type { Repo } from '../db/repo';
import type { SessionManager } from '../agent/session';
import type { WindowManager } from '../window';
import type { DecisionBroker } from '../autonomy/decision-broker';
import type { Settings } from '../autonomy/settings';
import type { ProcessRegistry } from '../shell/process-registry';
import type {
  SessionStartArgs,
  SessionStartResult,
  SessionSendArgs,
  SessionCancelArgs,
  SessionLoadArgs,
  SettingsView,
  ShortcutInfoView,
  AppInfo,
} from '@shared/ipc-contract';
import type { AutonomyMode, Message, SessionMeta } from '@shared/messages';
import { emitAutonomyEvent } from './events';
import { logger } from '../logger';
import { gatherShortcutInfo, openKeyboardSettings } from '../shortcut';
import { instanceDisplayName, isDevInstance } from '../instance';
import type { HotkeyManager } from '../hotkey';

export function registerIpcHandlers(deps: {
  repo: Repo;
  sessions: SessionManager;
  window: WindowManager;
  broker: DecisionBroker;
  settings: Settings;
  registry: ProcessRegistry;
  appVersion: string;
  recommendedChord: string;
  hotkey: HotkeyManager;
  applyStartAtLogin(enabled: boolean): void;
  openLogsDir(): void;
}): void {
  const { repo, sessions, window, broker, settings, registry } = deps;

  ipcMain.handle('session.start', async (_e, args: SessionStartArgs): Promise<SessionStartResult> => {
    return sessions.start(args);
  });

  ipcMain.handle('session.send', async (_e, args: SessionSendArgs): Promise<void> => {
    await sessions.send(args);
  });

  ipcMain.handle('session.cancel', async (_e, args: SessionCancelArgs): Promise<void> => {
    sessions.cancel(args);
  });

  ipcMain.handle('session.list', async (): Promise<SessionMeta[]> => {
    return repo.listSessions();
  });

  ipcMain.handle('session.load', async (_e, args: SessionLoadArgs): Promise<Message[]> => {
    return repo.loadMessages(args.sessionId);
  });

  ipcMain.handle('window.setMode', async (_e, args: { mode: 'bar' | 'panel' }): Promise<void> => {
    window.setMode(args.mode);
  });

  ipcMain.handle('window.hide', async (): Promise<void> => {
    window.hide();
  });

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

  ipcMain.handle('settings.openLogsDir', async (): Promise<void> => {
    deps.openLogsDir();
  });

  ipcMain.handle('settings.resetAllSessions', async (): Promise<{ deleted: number }> => {
    const deleted = repo.deleteAllSessions();
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

  settings.onChange((snap) => {
    broker.setMode(snap.autonomy.mode);
    emitAutonomyEvent({ type: 'mode-changed', mode: snap.autonomy.mode });
  });

  logger.info('ipc handlers registered');
}
