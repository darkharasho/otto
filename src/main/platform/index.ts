import { LinuxAdapter } from './linux';

export type DisplayServer = 'x11' | 'wayland' | 'unknown';

export interface PlatformAdapter {
  readonly name: 'linux' | 'darwin' | 'win32';
  detectDisplayServer(): DisplayServer;
  defaultHotkey(): string;
}

export function getPlatformAdapter(): PlatformAdapter {
  if (process.platform === 'linux') return new LinuxAdapter();
  throw new Error(`Otto skeleton supports linux only (current: ${process.platform})`);
}
