import type { DisplayServer, PlatformAdapter } from './index';

export class LinuxAdapter implements PlatformAdapter {
  readonly name = 'linux';

  detectDisplayServer(): DisplayServer {
    const s = (process.env.XDG_SESSION_TYPE ?? '').toLowerCase();
    if (s === 'wayland') return 'wayland';
    if (s === 'x11') return 'x11';
    return 'unknown';
  }

  defaultHotkey(): string {
    return 'Super+Space';
  }
}
