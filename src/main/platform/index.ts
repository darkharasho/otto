import { LinuxAdapter } from './linux';
import { DarwinAdapter } from './darwin';

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
  /** Capture only the window matching this name pattern. Resolved per-platform (kdotool on KDE). Mutually exclusive with `region`. */
  window?: string;
}

export interface CaptureResult {
  bytes: Buffer;
  width: number;
  height: number;
  /** All monitors with their virtual-desktop bounds. Coordinates in input tool args are virtual-desktop absolute. */
  monitors: MonitorInfo[];
  /**
   * Top-left of the captured image in virtual-desktop coords.
   * For full-desktop captures this is the virtual-desktop bounds origin (usually 0,0).
   * For region or window captures it is the region's top-left.
   * Consumers add this to image-local pixel offsets to get virtual coords.
   */
  origin: { x: number; y: number };
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

// The adapter must be a singleton so per-instance state (e.g. the portal
// input's tracked cursor position) survives across the many call sites
// that ask for an adapter — screenshot, click, move, shell, etc. Without
// this cache every call gets a fresh adapter and the tracked cursor is
// reset to null, breaking subsequent portal moves.
let cachedAdapter: PlatformAdapter | null = null;

export function getPlatformAdapter(): PlatformAdapter {
  if (cachedAdapter) return cachedAdapter;
  if (process.platform === 'linux') {
    cachedAdapter = new LinuxAdapter();
    return cachedAdapter;
  }
  if (process.platform === 'darwin') {
    cachedAdapter = new DarwinAdapter();
    return cachedAdapter;
  }
  throw new Error(`Otto does not support this platform (current: ${process.platform})`);
}
