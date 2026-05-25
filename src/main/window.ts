import { BrowserWindow, screen, app, shell } from 'electron';
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

export class WindowManager {
  private window: BrowserWindow | null = null;
  private mode: WindowMode = 'bar';
  private positionPref: WindowPositionPref = 'bottom-center';
  private hideOnBlur = false;
  private visibilityListeners: Array<(visible: boolean) => void> = [];

  onVisibilityChange(cb: (visible: boolean) => void): () => void {
    this.visibilityListeners.push(cb);
    return () => {
      this.visibilityListeners = this.visibilityListeners.filter((l) => l !== cb);
    };
  }

  private emitVisibility(visible: boolean): void {
    for (const cb of this.visibilityListeners) cb(visible);
  }

  setPositionPref(p: WindowPositionPref): void {
    this.positionPref = p;
  }

  setHideOnBlur(enabled: boolean): void {
    this.hideOnBlur = enabled;
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
        // Chromium throttles renderers in hidden windows, so session events
        // queue up and only flush when the window is shown again — which
        // briefly replays the streaming state before settling on `done`.
        // Keep the renderer ticking at full speed so its store stays in sync
        // even while hidden.
        backgroundThrottling: false,
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

    routeExternalLinksToBrowser(win, rendererUrl);

    // Click-outside-to-hide, gated by the user's hideOnBlur preference.
    win.on('blur', () => {
      if (this.hideOnBlur && this.window?.isVisible()) this.hide();
    });

    win.on('show', () => this.emitVisibility(true));
    win.on('hide', () => this.emitVisibility(false));

    this.window = win;
    return win;
  }

  show(mode: WindowMode = 'bar'): void {
    if (!this.window) return;
    this.applyMode(mode);
    this.window.show();
    // Re-apply position after show: Wayland compositors (Plasma in particular)
    // often ignore setBounds on hidden windows but honor it once the surface
    // is visible. Without this we land on the wrong monitor when the cursor
    // is on a non-primary display.
    this.repositionBottomCenter();
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
    this.mode = mode;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const maxPanelHeight = Math.floor(display.workArea.height * PANEL_MAX_DISPLAY_RATIO);
    const height =
      mode === 'bar' ? BAR_HEIGHT : Math.max(PANEL_MIN_HEIGHT, Math.min(maxPanelHeight, 520));
    const { x, y } = this.bottomCenter(display.workArea, BAR_WIDTH, height);
    // Single setBounds instead of a 12-frame interpolation. Wayland
    // compositors can drop/coalesce rapid bounds updates, which leaves the
    // window grown-but-not-repositioned — the input visually "jumps" because
    // the bottom edge wasn't pinned through the animation.
    this.window.setBounds({ x, y, width: BAR_WIDTH, height });
    logger.debug(`window mode → ${mode} (${BAR_WIDTH}x${height} @ ${x},${y})`);
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

export function routeExternalLinksToBrowser(win: BrowserWindow, rendererUrl: string): void {
  const isInternal = (url: string): boolean => {
    if (rendererUrl.startsWith('http')) {
      try {
        const base = new URL(rendererUrl);
        const target = new URL(url);
        return target.origin === base.origin;
      } catch {
        return false;
      }
    }
    return url.startsWith('file://');
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isInternal(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      void shell.openExternal(url);
    }
  });
}

export function rendererEntry(): string {
  if (process.env.ELECTRON_RENDERER_URL) return process.env.ELECTRON_RENDERER_URL;
  return path.join(app.getAppPath(), 'out', 'renderer', 'index.html');
}
