import { LinuxAdapter } from './linux';

export type DisplayServer = 'x11' | 'wayland' | 'unknown';

export interface ShellChild {
  pid: number;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal: NodeJS.Signals): boolean;
  exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

export interface PlatformAdapter {
  readonly name: 'linux' | 'darwin' | 'win32';
  detectDisplayServer(): DisplayServer;
  defaultHotkey(): string;
  shell: {
    spawnShell(command: string, cwd: string): ShellChild;
    composeEnv(): NodeJS.ProcessEnv;
  };
}

export function getPlatformAdapter(): PlatformAdapter {
  if (process.platform === 'linux') return new LinuxAdapter();
  throw new Error(`Otto skeleton supports linux only (current: ${process.platform})`);
}
