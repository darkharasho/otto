import { BrowserWindow, screen, app, shell } from 'electron';
import path from 'node:path';
import { logger } from './logger';

export type WindowMode = 'bar' | 'panel' | 'chat';

const BAR_WIDTH = 640;
const BAR_HEIGHT = 72;
const PANEL_MIN_HEIGHT = 320;
const PANEL_BOTTOM_MARGIN = 48;
const PANEL_TOP_MARGIN = 48;
const PANEL_MAX_DISPLAY_RATIO = 0.7;

const CHAT_DEFAULT_WIDTH = 960;
const CHAT_DEFAULT_HEIGHT = 620;
const CHAT_MIN_WIDTH = 560;
const CHAT_MIN_HEIGHT = 400;

export type WindowPositionPref = 'bottom-center' | 'top-center';
export type DisplayTargetPref = 'cursor' | 'primary';

export class WindowManager {
  private window: BrowserWindow | null = null;
  private mode: WindowMode = 'bar';
  private positionPref: WindowPositionPref = 'bottom-center';
  private displayTarget: DisplayTargetPref = 'cursor';
  // Runtime-only override from the cycle-display shortcut. Cleared if the
  // chosen display disappears (cable unplug, suspend/resume). Not persisted —
  // display IDs aren't stable across reboots on most compositors.
  private cycledDisplayId: number | null = null;
  private hideOnBlur = false;
  private visibilityListeners: Array<(visible: boolean) => void> = [];
  private chatBounds: { x: number; y: number; width: number; height: number } | null = null;
  private chatBoundsChangeListeners: Array<(b: { x: number; y: number; width: number; height: number }) => void> = [];
  private chatHandlersBound = false;

  onVisibilityChange(cb: (visible: boolean) => void): () => void {
    this.visibilityListeners.push(cb);
    return () => {
      this.visibilityListeners = this.visibilityListeners.filter((l) => l !== cb);
    };
  }

  private emitVisibility(visible: boolean): void {
    for (const cb of this.visibilityListeners) cb(visible);
  }

  setChatBounds(bounds: { x: number; y: number; width: number; height: number } | null): void {
    this.chatBounds = bounds;
  }

  getChatBounds(): { x: number; y: number; width: number; height: number } | null {
    return this.chatBounds;
  }

  onChatBoundsChanged(cb: (b: { x: number; y: number; width: number; height: number }) => void): () => void {
    this.chatBoundsChangeListeners.push(cb);
    return () => {
      this.chatBoundsChangeListeners = this.chatBoundsChangeListeners.filter((l) => l !== cb);
    };
  }

  private emitChatBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    for (const cb of this.chatBoundsChangeListeners) cb(bounds);
  }

  private isOnAnyDisplay(b: { x: number; y: number; width: number; height: number }): boolean {
    return screen.getAllDisplays().some((d) => {
      const wa = d.workArea;
      return b.x < wa.x + wa.width && b.x + b.width > wa.x && b.y < wa.y + wa.height && b.y + b.height > wa.y;
    });
  }

  private defaultChatBounds(display: Electron.Display): { x: number; y: number; width: number; height: number } {
    return {
      x: Math.round(display.workArea.x + (display.workArea.width - CHAT_DEFAULT_WIDTH) / 2),
      y: Math.round(display.workArea.y + (display.workArea.height - CHAT_DEFAULT_HEIGHT) / 2),
      width: CHAT_DEFAULT_WIDTH,
      height: CHAT_DEFAULT_HEIGHT,
    };
  }

  setPositionPref(p: WindowPositionPref): void {
    this.positionPref = p;
  }

  setDisplayTarget(t: DisplayTargetPref): void {
    if (this.displayTarget !== t) {
      // Explicit user choice supersedes any prior cycle override.
      this.cycledDisplayId = null;
    }
    this.displayTarget = t;
  }

  cycleDisplay(direction: 'next' | 'prev' = 'next'): void {
    if (!this.window) return;
    const displays = screen.getAllDisplays();
    if (displays.length < 2) return;
    const current = this.pickDisplay();
    const idx = displays.findIndex((d) => d.id === current.id);
    const step = direction === 'prev' ? -1 : 1;
    const nextIdx = (idx + step + displays.length) % displays.length;
    const next = displays[nextIdx];
    if (!next) return;
    this.cycledDisplayId = next.id;
    this.applyMode(this.mode);
  }

  private pickDisplay(): Electron.Display {
    if (this.cycledDisplayId != null) {
      const match = screen.getAllDisplays().find((d) => d.id === this.cycledDisplayId);
      if (match) return match;
      this.cycledDisplayId = null;
    }
    if (this.displayTarget === 'primary') return screen.getPrimaryDisplay();
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
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
      // macOS adds a native shadow to frameless windows, which shows as dark
      // border artifacts around transparent/rounded content.
      hasShadow: process.platform !== 'darwin',
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

    // Dev-only: F12 toggles DevTools (removeMenu() stripped the default
    // Cmd/Ctrl+Shift+I binding).
    if (!app.isPackaged) {
      win.webContents.on('before-input-event', (_e, input) => {
        if (input.type === 'keyDown' && input.key === 'F12') {
          win.webContents.toggleDevTools();
        }
      });
    }

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

  private ensureChatHandlers(): void {
    if (this.chatHandlersBound || !this.window) return;
    const win = this.window;
    let persistTimer: NodeJS.Timeout | null = null;
    const schedulePersist = (): void => {
      if (this.mode !== 'chat') return;
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        const b = win.getBounds();
        this.chatBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
        this.emitChatBounds(this.chatBounds);
      }, 250);
    };
    win.on('move', schedulePersist);
    win.on('resize', schedulePersist);
    this.chatHandlersBound = true;
  }

  private applyMode(mode: WindowMode): void {
    if (!this.window) return;
    this.mode = mode;

    if (mode === 'chat') {
      this.ensureChatHandlers();
      this.window.setMinimumSize(CHAT_MIN_WIDTH, CHAT_MIN_HEIGHT);
      const display = this.pickDisplay();
      const target = this.chatBounds && this.isOnAnyDisplay(this.chatBounds)
        ? this.chatBounds
        : this.defaultChatBounds(display);
      this.window.setBounds(target);
      logger.debug(`window mode → chat (${target.width}x${target.height} @ ${target.x},${target.y})`);
      return;
    }

    // Existing bar/panel logic (preserved verbatim):
    const display = this.pickDisplay();
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
    const display = this.pickDisplay();
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
