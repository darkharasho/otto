import { app, dialog } from 'electron';
import path from 'node:path';
import { logger, ottoConfigDir } from './logger';
import { openDatabase } from './db/db';
import { Repo } from './db/repo';
import { WindowManager, rendererEntry } from './window';
import { HotkeyManager } from './hotkey';
import { getPlatformAdapter } from './platform';
import { SessionManager } from './agent/session';
import { createRealSdkClient } from './agent/sdk-client';
import { registerIpcHandlers } from './ipc/handlers';
import { emitSessionEvent } from './ipc/events';

const SMART_RESUME_WINDOW_MS = 30 * 60 * 1000;

// Prefer Wayland native rendering when available; fall back to X11.
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations,UseOzonePlatform');
// Some Wayland compositors crash the GPU process on transparent windows; disable hw accel.
app.disableHardwareAcceleration();

async function bootstrap() {
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
  const sdk = createRealSdkClient();
  const sessions = new SessionManager(repo, sdk, 'claude-sonnet-4-6', emitSessionEvent);

  const preloadPath = path.join(app.getAppPath(), 'out', 'preload', 'index.js');
  window.create(preloadPath, rendererEntry());

  registerIpcHandlers({ repo, sessions, window });

  const hotkey = new HotkeyManager(platform, () => {
    const mode = shouldResume(repo, sessions) ? 'panel' : 'bar';
    window.toggle(mode);
  });
  try {
    const hotkeyState = await hotkey.register();
    if (!hotkeyState.registered) {
      logger.warn(`hotkey not registered: ${hotkeyState.failureReason}`);
    }
  } catch (err) {
    logger.warn(`hotkey registration threw: ${err instanceof Error ? err.message : err}`);
  }

  app.on('window-all-closed', () => {
    // keep running in background; quit via tray/menu (future)
  });

  app.on('before-quit', () => {
    hotkey.unregisterAll();
    db.close();
  });

  process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', reason));
  process.on('uncaughtException', (err) => logger.error('uncaughtException', err));
}

function shouldResume(repo: Repo, sessions: SessionManager): boolean {
  const active = sessions.getActiveSessionId();
  if (!active) return false;
  const meta = repo.getSession(active);
  if (!meta) return false;
  return meta.status === 'active' || Date.now() - meta.lastActive < SMART_RESUME_WINDOW_MS;
}

bootstrap().catch((err) => {
  logger.error('bootstrap failed', err);
  app.exit(1);
});
