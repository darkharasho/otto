import { globalShortcut } from 'electron';
import { logger } from './logger';
import type { PlatformAdapter } from './platform';
import { WaylandPortalHotkey } from './platform/wayland-portal';

export interface HotkeyState {
  registered: boolean;
  failureReason: string | null;
}

export class HotkeyManager {
  private state: HotkeyState = { registered: false, failureReason: null };
  private waylandHotkey: WaylandPortalHotkey | null = null;

  constructor(
    private readonly platform: PlatformAdapter,
    private readonly onTrigger: () => void
  ) {}

  async register(): Promise<HotkeyState> {
    const accelerator = this.platform.defaultHotkey();
    const display = this.platform.name === 'linux' ? this.platform.detectDisplayServer() : 'n/a';

    if (this.platform.name === 'linux' && display === 'wayland') {
      const portal = new WaylandPortalHotkey(accelerator, 'toggle', 'Toggle Otto');
      const result = await portal.register(this.onTrigger);
      if (!result.ok) {
        logger.warn(`wayland portal hotkey unavailable: ${result.reason}`);
        this.state = { registered: false, failureReason: result.reason };
        return this.state;
      }
      this.waylandHotkey = portal;
      this.state = { registered: true, failureReason: null };
      logger.info(`hotkey registered via xdg-desktop-portal: ${accelerator}`);
      return this.state;
    }

    const ok = globalShortcut.register(accelerator, this.onTrigger);
    if (!ok) {
      const msg = `Failed to register hotkey ${accelerator}. Another application may hold it.`;
      logger.warn(msg);
      this.state = { registered: false, failureReason: msg };
      return this.state;
    }
    this.state = { registered: true, failureReason: null };
    logger.info(`hotkey registered: ${accelerator}`);
    return this.state;
  }

  unregisterAll(): void {
    globalShortcut.unregisterAll();
    if (this.waylandHotkey) {
      const wh = this.waylandHotkey;
      this.waylandHotkey = null;
      wh.dispose().catch((err) => logger.warn(`wayland portal dispose failed: ${err}`));
    }
  }

  getState(): HotkeyState {
    return this.state;
  }
}
