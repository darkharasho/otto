import { globalShortcut } from 'electron';
import { logger } from './logger';
import type { PlatformAdapter } from './platform';

export type HotkeyMechanism = 'global-shortcut' | 'external-toggle' | 'none';

export interface HotkeyState {
  registered: boolean;
  failureReason: string | null;
  mechanism: HotkeyMechanism;
  /** Kept so older renderer code can branch on Wayland without switch-on-enum. */
  usingExternalToggle?: boolean;
}

export class HotkeyManager {
  private state: HotkeyState = {
    registered: false,
    failureReason: null,
    mechanism: 'none',
  };

  constructor(
    private readonly platform: PlatformAdapter,
    private readonly onTrigger: () => void
  ) {}

  async register(): Promise<HotkeyState> {
    const accelerator = this.platform.defaultHotkey();
    const display = this.platform.name === 'linux' ? this.platform.detectDisplayServer() : 'n/a';

    if (this.platform.name === 'linux' && display === 'wayland') {
      // Wayland has no portable global-hotkey API for Electron. We tried
      // xdg-desktop-portal (blocked for non-sandboxed apps) and KDE's
      // kglobalaccel D-Bus (registers but KWin doesn't grab the keys). The
      // working fallback is a Unix-socket toggle server: users bind a DE
      // keyboard shortcut to `otto toggle`, which talks to that socket. The
      // Settings UI surfaces the exact command to paste.
      logger.info(
        'Wayland detected — running toggle server. Bind a DE keyboard shortcut to: otto toggle'
      );
      this.state = {
        registered: false,
        failureReason: null,
        mechanism: 'external-toggle',
        usingExternalToggle: true,
      };
      return this.state;
    }

    const ok = globalShortcut.register(accelerator, this.onTrigger);
    if (!ok) {
      const msg = `Failed to register hotkey ${accelerator}. Another application may hold it.`;
      logger.warn(msg);
      this.state = { registered: false, failureReason: msg, mechanism: 'none' };
      return this.state;
    }
    this.state = { registered: true, failureReason: null, mechanism: 'global-shortcut' };
    logger.info(`hotkey registered: ${accelerator}`);
    return this.state;
  }

  unregisterAll(): void {
    globalShortcut.unregisterAll();
  }

  getState(): HotkeyState {
    return this.state;
  }
}
