import { globalShortcut } from 'electron';
import { logger } from './logger';
import type { PlatformAdapter } from './platform';

export interface HotkeyState {
  registered: boolean;
  failureReason: string | null;
  usingExternalToggle?: boolean;
}

export class HotkeyManager {
  private state: HotkeyState = { registered: false, failureReason: null };

  constructor(
    private readonly platform: PlatformAdapter,
    private readonly onTrigger: () => void
  ) {}

  async register(): Promise<HotkeyState> {
    const accelerator = this.platform.defaultHotkey();
    const display = this.platform.name === 'linux' ? this.platform.detectDisplayServer() : 'n/a';

    if (this.platform.name === 'linux' && display === 'wayland') {
      // Wayland has no portable global-hotkey API for Electron, and
      // xdg-desktop-portal's GlobalShortcuts interface is unreliable across
      // compositors (notably broken on Bazzite/KDE). Instead, the main
      // process runs a toggle server on a Unix socket; users bind their DE
      // keyboard shortcut to `otto toggle`, which talks to that socket.
      logger.info('Wayland detected — running toggle server. Bind a DE keyboard shortcut to: otto toggle');
      this.state = { registered: false, failureReason: null, usingExternalToggle: true };
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
  }

  getState(): HotkeyState {
    return this.state;
  }
}
