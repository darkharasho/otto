import { globalShortcut } from 'electron';
import { logger } from './logger';
import type { PlatformAdapter } from './platform';
import {
  registerDarwinShortcut,
  unregisterDarwinShortcut,
  promptAccessibility,
} from './platform/darwin-shortcut';

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

  private usingDarwinNative = false;

  constructor(
    private readonly platform: PlatformAdapter,
    private readonly onTrigger: () => void,
    private readonly configDir?: string,
  ) {}

  async register(): Promise<HotkeyState> {
    const accelerator = this.platform.defaultHotkey();

    // macOS: use a native CGEvent tap for global hotkey.
    // Electron's globalShortcut uses deprecated Carbon APIs that are broken on
    // macOS 26 Tahoe — register() returns true but the callback never fires.
    // CGEvent taps require Accessibility permission — prod apps get prompted
    // automatically; dev builds need manual setup.
    if (this.platform.name === 'darwin') {
      const ok = registerDarwinShortcut(accelerator, this.onTrigger);
      if (ok) {
        this.usingDarwinNative = true;
        this.state = { registered: true, failureReason: null, mechanism: 'global-shortcut' };
        logger.info(`hotkey registered via native CGEvent tap: ${accelerator}`);
        return this.state;
      }
      // Registration failed — most likely missing Accessibility permission.
      // Prompt the user (shows macOS system dialog on first call).
      logger.warn('darwin-shortcut: CGEvent tap failed — prompting for Accessibility permission');
      promptAccessibility();
      this.state = {
        registered: false,
        failureReason: 'Accessibility permission required. Grant it in System Settings > Privacy & Security > Accessibility, then relaunch.',
        mechanism: 'none',
      };
      return this.state;
    }

    // Wayland: Electron's globalShortcut silently drops events even though
    // register() returns true. Use the toggle server as the primary mechanism.
    if (this.platform.name === 'linux' && this.platform.detectDisplayServer() === 'wayland') {
      logger.info(
        'Wayland detected — using toggle server. Bind a keyboard shortcut to: otto toggle'
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
    if (this.usingDarwinNative) {
      unregisterDarwinShortcut();
      this.usingDarwinNative = false;
    }
    globalShortcut.unregisterAll();
  }

  getState(): HotkeyState {
    return this.state;
  }
}
