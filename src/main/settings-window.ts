import { BrowserWindow, app, screen } from 'electron';
import path from 'node:path';
import { logger } from './logger';
import { isDevInstance } from './instance';
import { routeExternalLinksToBrowser } from './window';

const WIDTH = 780;
const HEIGHT = 720;

export class SettingsWindowManager {
  private window: BrowserWindow | null = null;

  constructor(
    private readonly preloadPath: string,
    private readonly rendererUrl: string
  ) {}

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }
    this.window = this.create();
    this.window.once('ready-to-show', () => {
      this.window?.show();
      this.window?.focus();
    });
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  private create(): BrowserWindow {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const x = Math.round(display.workArea.x + (display.workArea.width - WIDTH) / 2);
    const y = Math.round(display.workArea.y + (display.workArea.height - HEIGHT) / 2);

    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: false,
      show: false,
      title: 'Otto Settings',
      icon: path.join(
        app.getAppPath(),
        'public',
        'tray',
        isDevInstance() ? 'tray-icon-dev@3x.png' : 'tray-icon@3x.png'
      ),
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.removeMenu();

    // Route the renderer to the Settings page via a hash.
    if (this.rendererUrl.startsWith('http')) {
      win.loadURL(`${this.rendererUrl}#settings`);
    } else {
      win.loadFile(this.rendererUrl, { hash: 'settings' });
    }

    routeExternalLinksToBrowser(win, this.rendererUrl);

    win.on('closed', () => {
      this.window = null;
    });

    logger.debug(`settings window created (${WIDTH}x${HEIGHT} @ ${x},${y})`);
    return win;
  }
}
