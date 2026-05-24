import type { MessageBus } from 'dbus-next';
import { screen } from 'electron';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from '../logger';

export type MouseButton = 'left' | 'right' | 'middle';

export interface InputHandle {
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number, button: MouseButton): Promise<void>;
  doubleClick(x: number, y: number, button: MouseButton): Promise<void>;
  drag(x1: number, y1: number, x2: number, y2: number, button: MouseButton): Promise<void>;
  scroll(dx: number, dy: number, x?: number, y?: number): Promise<void>;
}

export interface PortalDeps {
  /** Directory holding `remote-desktop-token`. */
  configDir: string;
  /** Inject a bus for tests; real callers omit and we connect to the session bus. */
  bus?: MessageBus;
  /** Inject the cursor reader for tests. Defaults to Electron's screen API. */
  getCursor?: () => { x: number; y: number };
}

export function createPortalInput(deps: PortalDeps): InputHandle {
  // Real implementation lands in Task 2. This stub keeps the file compilable
  // so the platform adapter wiring can land first.
  void deps;
  const unimplemented = async (): Promise<void> => {
    throw new Error('portal input not yet implemented');
  };
  return {
    move: unimplemented,
    click: unimplemented,
    doubleClick: unimplemented,
    drag: unimplemented,
    scroll: unimplemented,
  };
}

// Reference unused imports to silence lint until Task 2 wires them up.
void screen;
void fsp;
void path;
void randomBytes;
void logger;
