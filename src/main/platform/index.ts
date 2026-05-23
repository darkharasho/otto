import { LinuxAdapter } from './linux';

export type DisplayServer = 'x11' | 'wayland' | 'unknown';

export interface ShellChild {
  pid: number;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal: NodeJS.Signals): boolean;
  exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

export interface MonitorInfo {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export interface CaptureOptions {
  region?: { x: number; y: number; w: number; h: number };
}

export interface CaptureResult {
  bytes: Buffer;
  width: number;
  height: number;
  monitor: MonitorInfo;
}

export type MouseButton = 'left' | 'right' | 'middle';
export interface CursorPosition { x: number; y: number; }
export interface PlatformInput {
  cursorPosition(): Promise<CursorPosition>;
  move(x: number, y: number): Promise<void>;
  scroll(dx: number, dy: number, x?: number, y?: number): Promise<void>;
  click(x: number, y: number, button: MouseButton): Promise<void>;
  doubleClick(x: number, y: number, button: MouseButton): Promise<void>;
  drag(x1: number, y1: number, x2: number, y2: number, button: MouseButton): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>;
}

export interface PlatformAdapter {
  readonly name: 'linux' | 'darwin' | 'win32';
  detectDisplayServer(): DisplayServer;
  defaultHotkey(): string;
  shell: {
    spawnShell(command: string, cwd: string): ShellChild;
    composeEnv(): NodeJS.ProcessEnv;
  };
  screenshot: {
    capture(opts: CaptureOptions): Promise<CaptureResult>;
  };
  input: PlatformInput;
}

export function getPlatformAdapter(): PlatformAdapter {
  if (process.platform === 'linux') return new LinuxAdapter();
  throw new Error(`Otto skeleton supports linux only (current: ${process.platform})`);
}
