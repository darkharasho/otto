import { globalShortcut } from 'electron';
import { logger } from './logger';
import type { PlatformAdapter } from './platform';

export interface HotkeyState {
  registered: boolean;
  failureReason: string | null;
}

export class HotkeyManager {
  private state: HotkeyState = { registered: false, failureReason: null };

  constructor(
    private readonly platform: PlatformAdapter,
    private readonly onTrigger: () => void
  ) {}

  register(): HotkeyState {
    const accelerator = this.platform.defaultHotkey();
    const display = this.platform.name === 'linux' ? this.platform.detectDisplayServer() : 'n/a';

    if (this.platform.name === 'linux' && display === 'wayland') {
      const msg = 'Wayland detected — global hotkey may not fire. Use a desktop shortcut to launch `otto toggle` (deferred).';
      logger.warn(msg);
      this.state = { registered: false, failureReason: msg };
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
