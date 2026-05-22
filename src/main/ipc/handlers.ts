import { ipcMain } from 'electron';
import type { Repo } from '../db/repo';
import type { SessionManager } from '../agent/session';
import type { WindowManager } from '../window';
import type {
  SessionStartArgs,
  SessionStartResult,
  SessionSendArgs,
  SessionCancelArgs,
  SessionLoadArgs,
} from '@shared/ipc-contract';
import type { Message, SessionMeta } from '@shared/messages';
import { logger } from '../logger';

export function registerIpcHandlers(deps: {
  repo: Repo;
  sessions: SessionManager;
  window: WindowManager;
}): void {
  const { repo, sessions, window } = deps;

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

  logger.info('ipc handlers registered');
}
