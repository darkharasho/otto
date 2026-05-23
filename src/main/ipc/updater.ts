import { app, ipcMain, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { logger } from '../logger';
import { createUpdater, type UpdaterApi, type UpdaterState } from '../updater';

let api: UpdaterApi | null = null;

export function setupUpdaterIpc(getWindows: () => BrowserWindow[]): UpdaterApi | null {
  // No-op in dev — electron-updater can't resolve a feed without a packaged build.
  if (!app.isPackaged) {
    ipcMain.handle('updater:status', () => ({ kind: 'idle' } satisfies UpdaterState));
    ipcMain.handle('updater:check', () => ({ kind: 'idle' } satisfies UpdaterState));
    ipcMain.handle('updater:download', () => ({ kind: 'idle' } satisfies UpdaterState));
    ipcMain.handle('updater:install', () => undefined);
    return null;
  }

  autoUpdater.logger = logger;

  api = createUpdater({
    autoUpdater: autoUpdater as unknown as Parameters<typeof createUpdater>[0]['autoUpdater'],
    setInterval,
    clearInterval,
    onStateChange: (state) => {
      for (const w of getWindows()) {
        if (!w.isDestroyed()) w.webContents.send('updater:state', state);
      }
    },
  });

  ipcMain.handle('updater:status', () => api!.getState());
  ipcMain.handle('updater:check', async () => { await api!.check(); return api!.getState(); });
  ipcMain.handle('updater:download', async () => { await api!.download(); return api!.getState(); });
  ipcMain.handle('updater:install', () => api!.install());

  // First check ~30s after startup so we don't block the boot path.
  setTimeout(() => { void api!.check(); }, 30_000);

  return api;
}

export function disposeUpdater() {
  api?.dispose();
  api = null;
}
