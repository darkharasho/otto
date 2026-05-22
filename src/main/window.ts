import { BrowserWindow, screen, app } from 'electron';
import path from 'node:path';
import { logger } from './logger';

export type WindowMode = 'bar' | 'panel';

const BAR_WIDTH = 640;
const BAR_HEIGHT = 56;
const PANEL_MIN_HEIGHT = 320;
const PANEL_TOP_MARGIN = 64;
const PANEL_MAX_DISPLAY_RATIO = 0.7;

export class WindowManager {
  private window: BrowserWindow | null = null;
  private mode: WindowMode = 'bar';

  create(preloadPath: string, rendererUrl: string): BrowserWindow {
    const win = new BrowserWindow({
      width: BAR_WIDTH,
      height: BAR_HEIGHT,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: true,
      skipTaskbar: true,
      focusable: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.removeMenu();

    if (rendererUrl.startsWith('http')) {
      win.loadURL(rendererUrl);
    } else {
      win.loadFile(rendererUrl);
    }

    this.window = win;
    return win;
  }

  show(mode: WindowMode = 'bar'): void {
    if (!this.window) return;
    this.applyMode(mode);
    this.repositionTopCenter();
    this.window.show();
    this.window.focus();
  }

  hide(): void {
    this.window?.hide();
  }

  toggle(mode: WindowMode = 'bar'): void {
    if (!this.window) return;
    if (this.window.isVisible()) this.hide();
    else this.show(mode);
  }

  setMode(mode: WindowMode): void {
    this.applyMode(mode);
  }

  getMode(): WindowMode {
    return this.mode;
  }

  isVisible(): boolean {
    return this.window?.isVisible() ?? false;
  }

  destroy(): void {
    this.window?.destroy();
    this.window = null;
  }

  private applyMode(mode: WindowMode): void {
    if (!this.window) return;
    this.mode = mode;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const maxPanelHeight = Math.floor(display.workArea.height * PANEL_MAX_DISPLAY_RATIO);
    const height =
      mode === 'bar' ? BAR_HEIGHT : Math.max(PANEL_MIN_HEIGHT, Math.min(maxPanelHeight, 520));
    const { x, y } = this.topCenter(display.workArea, BAR_WIDTH);
    this.window.setBounds({ x, y, width: BAR_WIDTH, height });
    logger.debug(`window mode → ${mode} (${BAR_WIDTH}x${height} @ ${x},${y})`);
  }

  private repositionTopCenter(): void {
    if (!this.window) return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = this.window.getBounds();
    const { x, y } = this.topCenter(display.workArea, bounds.width);
    this.window.setBounds({ ...bounds, x, y });
  }

  private topCenter(workArea: Electron.Rectangle, width: number): { x: number; y: number } {
    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    const y = workArea.y + PANEL_TOP_MARGIN;
    return { x, y };
  }
}

export function rendererEntry(): string {
  if (process.env.ELECTRON_RENDERER_URL) return process.env.ELECTRON_RENDERER_URL;
  return path.join(app.getAppPath(), 'out', 'renderer', 'index.html');
}
