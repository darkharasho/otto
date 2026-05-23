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
} from '@shared/ipc-contract';
import type { AutonomyMode, Message, SessionMeta } from '@shared/messages';
import { emitAutonomyEvent } from './events';
import { logger } from '../logger';

export function registerIpcHandlers(deps: {
  repo: Repo;
  sessions: SessionManager;
  window: WindowManager;
  broker: DecisionBroker;
  settings: Settings;
  registry: ProcessRegistry;
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

  settings.onChange((mode) => {
    broker.setMode(mode);
    emitAutonomyEvent({ type: 'mode-changed', mode });
  });

  logger.info('ipc handlers registered');
}
