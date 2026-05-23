import { BrowserWindow, screen } from 'electron';
import type { SessionEvent } from '@shared/ipc-contract';
import { logger } from './logger';

const WIDTH = 380;
const HEIGHT = 220;
const MARGIN = 16;
const LINGER_MS = 3000;

export class OverlayManager {
  private window: BrowserWindow | null = null;
  private turnActive = false;
  private mainVisible = false;
  private lingerTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly preloadPath: string,
    private readonly rendererUrl: string,
    private readonly isMainVisible: () => boolean
  ) {}

  start(): void {
    this.mainVisible = this.isMainVisible();
    this.create();
  }

  setMainVisible(visible: boolean): void {
    this.mainVisible = visible;
    this.applyVisibility();
  }

  handleSessionEvent(ev: SessionEvent): void {
    // Track turn lifecycle. The model emits message-start at the beginning of
    // each assistant turn and `done` once the turn finishes (including any
    // tool round-trips). We treat the span between as "Otto is working."
    if (ev.type === 'message-start') {
      this.turnActive = true;
      this.clearLinger();
      this.applyVisibility();
    } else if (ev.type === 'done') {
      this.turnActive = false;
      this.scheduleHide();
    }
  }

  destroy(): void {
    this.clearLinger();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  private create(): void {
    const { x, y } = this.bottomRight();
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      x,
      y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: false });
    win.removeMenu();

    if (this.rendererUrl.startsWith('http')) {
      win.loadURL(`${this.rendererUrl}#overlay`);
    } else {
      win.loadFile(this.rendererUrl, { hash: 'overlay' });
    }

    this.window = win;
    logger.debug(`overlay window created (${WIDTH}x${HEIGHT} @ ${x},${y})`);
  }

  private applyVisibility(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const shouldShow = this.turnActive && !this.mainVisible;
    if (shouldShow) {
      const { x, y } = this.bottomRight();
      this.window.setBounds({ x, y, width: WIDTH, height: HEIGHT });
      if (!this.window.isVisible()) this.window.showInactive();
    } else if (!this.lingerTimer && this.window.isVisible()) {
      this.window.hide();
    }
  }

  private scheduleHide(): void {
    this.clearLinger();
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      this.applyVisibility();
    }, LINGER_MS);
  }

  private clearLinger(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
  }

  private bottomRight(): { x: number; y: number } {
    const display = screen.getPrimaryDisplay();
    const wa = display.workArea;
    return {
      x: wa.x + wa.width - WIDTH - MARGIN,
      y: wa.y + wa.height - HEIGHT - MARGIN,
    };
  }
}
