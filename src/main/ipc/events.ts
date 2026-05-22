import { BrowserWindow } from 'electron';
import { SESSION_EVENT_CHANNEL, type SessionEvent } from '@shared/ipc-contract';

export function emitSessionEvent(event: SessionEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(SESSION_EVENT_CHANNEL, event);
  }
}
