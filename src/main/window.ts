import { BrowserWindow, screen, app } from 'electron';
import path from 'node:path';
import { logger } from './logger';

export type WindowMode = 'bar' | 'panel';

const BAR_WIDTH = 640;
const BAR_HEIGHT = 72;
const PANEL_MIN_HEIGHT = 320;
const PANEL_BOTTOM_MARGIN = 48;
const PANEL_TOP_MARGIN = 48;
const PANEL_MAX_DISPLAY_RATIO = 0.7;

export type WindowPositionPref = 'bottom-center' | 'top-center';

const RESIZE_DURATION_MS = 180;

export class WindowManager {
  private window: BrowserWindow | null = null;
  private mode: WindowMode = 'bar';
  private resizeAnimId = 0;
  private positionPref: WindowPositionPref = 'bottom-center';

  setPositionPref(p: WindowPositionPref): void {
    this.positionPref = p;
  }

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
    this.repositionBottomCenter();
    this.window.show();
    this.window.focus();
  }

  hide(): void {
    this.window?.hide();
  }

  toggle(mode: WindowMode = 'bar'): void {
    if (!this.window) return;
    // Strict toggle: hotkey always inverts visibility. The earlier
    // "smart re-focus when visible-but-unfocused" path looked like the
    // hotkey did nothing (window was already visible, focus change is
    // invisible to the user), forcing a second press to actually hide.
    if (this.window.isVisible()) {
      this.hide();
    } else {
      this.show(mode);
    }
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

  isFocused(): boolean {
    return this.window?.isFocused() ?? false;
  }

  destroy(): void {
    this.window?.destroy();
    this.window = null;
  }

  private applyMode(mode: WindowMode): void {
    if (!this.window) return;
    const wasMode = this.mode;
    this.mode = mode;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const maxPanelHeight = Math.floor(display.workArea.height * PANEL_MAX_DISPLAY_RATIO);
    const height =
      mode === 'bar' ? BAR_HEIGHT : Math.max(PANEL_MIN_HEIGHT, Math.min(maxPanelHeight, 520));
    const { x, y } = this.bottomCenter(display.workArea, BAR_WIDTH, height);
    const target = { x, y, width: BAR_WIDTH, height };
    if (this.window.isVisible() && wasMode !== mode) {
      this.animateBoundsTo(target, RESIZE_DURATION_MS);
    } else {
      this.window.setBounds(target);
    }
    logger.debug(`window mode → ${mode} (${BAR_WIDTH}x${height} @ ${x},${y})`);
  }

  private animateBoundsTo(target: Electron.Rectangle, duration: number): void {
    if (!this.window) return;
    this.resizeAnimId += 1;
    const id = this.resizeAnimId;
    const start = this.window.getBounds();
    const startTime = Date.now();
    // ease-out cubic — quick first, settles softly
    const ease = (t: number): number => 1 - Math.pow(1 - t, 3);
    const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
    const step = () => {
      if (id !== this.resizeAnimId || !this.window || this.window.isDestroyed()) return;
      const t = Math.min(1, (Date.now() - startTime) / duration);
      const e = ease(t);
      this.window.setBounds({
        x: lerp(start.x, target.x, e),
        y: lerp(start.y, target.y, e),
        width: lerp(start.width, target.width, e),
        height: lerp(start.height, target.height, e),
      });
      if (t < 1) setTimeout(step, 16);
    };
    step();
  }

  private repositionBottomCenter(): void {
    if (!this.window) return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = this.window.getBounds();
    const { x, y } = this.bottomCenter(display.workArea, bounds.width, bounds.height);
    this.window.setBounds({ ...bounds, x, y });
  }

  private bottomCenter(
    workArea: Electron.Rectangle,
    width: number,
    height: number
  ): { x: number; y: number } {
    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    if (this.positionPref === 'top-center') {
      return { x, y: workArea.y + PANEL_TOP_MARGIN };
    }
    return { x, y: workArea.y + workArea.height - height - PANEL_BOTTOM_MARGIN };
  }
}

export function rendererEntry(): string {
  if (process.env.ELECTRON_RENDERER_URL) return process.env.ELECTRON_RENDERER_URL;
  return path.join(app.getAppPath(), 'out', 'renderer', 'index.html');
}
