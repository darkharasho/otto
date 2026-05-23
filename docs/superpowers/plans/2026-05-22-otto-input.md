# Otto Input Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 8 input-injection tools (`get_cursor_position`, `move`, `scroll`, `click`, `double_click`, `drag`, `type`, `key`) that run through `ydotool` on Linux/Wayland. Coordinates are active-monitor relative (same convention as `screenshot`). Action classes wired into the autonomy matrix (`read` / `reversible` / `destructive`). Setup-check auto-runs `systemctl --user enable --now ydotoold` when needed, and surfaces actionable hints for the manual steps (install ydotool, add user to `input` group).

**Architecture:** New `src/main/input/` module with three units — `executor.ts` (action dispatch + delay), `keymap.ts` (xdotool-style combo → Linux event codes), `setup-check.ts` (probe + auto-recover ydotoold). The `PlatformAdapter` gains an `input` namespace; `LinuxAdapter` shells out to ydotool. `buildInputTools()` in `src/main/agent/tools.ts` produces 8 tools whose `run` throws so the SDK handler intercepts (same pattern as `shell_spawn` and `screenshot`). No new IPC, no new ContentBlock, no SessionEvent additions. Spec: `docs/superpowers/specs/2026-05-22-otto-input-design.md`.

**Tech Stack:** TypeScript, Vitest, Electron IPC, `node:child_process`, `ydotool` (system package), no new npm deps.

---

## File Structure

```
src/main/input/
  executor.ts                  # Task 3: InputAction dispatch + delay
  executor.test.ts
  keymap.ts                    # Task 2: translateKeyCombo
  keymap.test.ts
  setup-check.ts               # Task 4: checkYdotoolReady (probe + auto-enable)
  setup-check.test.ts
src/main/platform/
  index.ts                     # Task 1: +PlatformAdapter.input interface
  linux.ts                     # Task 5: ydotool impl
src/main/agent/
  tools.ts                     # Task 6: +buildInputTools
  tools.test.ts                # Task 6
  sdk-client.ts                # Task 7: include input tools + dispatch
```

No changes to `src/shared/`, `src/renderer/`, IPC contract, or store. Input rides on existing tool_use / tool_result content blocks rendered by the existing `ToolCallCard`.

---

## Task 1: PlatformAdapter.input interface

**Files:**
- Modify: `src/main/platform/index.ts`

Pure type addition. Leaves typecheck broken until Task 5 implements it on `LinuxAdapter` — intentional.

- [ ] **Step 1: Read `src/main/platform/index.ts`**

It already has `name`, `detectDisplayServer`, `defaultHotkey`, `shell`, `screenshot`. Adding a sibling `input` namespace.

- [ ] **Step 2: Add input types and extend the interface**

Add (alongside the existing `MonitorInfo`, `ShellChild`, etc.):

```ts
export type MouseButton = 'left' | 'right' | 'middle';

export interface CursorPosition {
  x: number;
  y: number;
}

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
```

Extend `PlatformAdapter`:

```ts
export interface PlatformAdapter {
  // ... existing ...
  input: PlatformInput;
}
```

- [ ] **Step 3: Typecheck (expected FAIL — Linux impl missing; Task 5 closes it)**

Run: `npm run typecheck`
Expected: FAIL — `LinuxAdapter` doesn't implement `input`.

- [ ] **Step 4: Commit**

```bash
git add src/main/platform/index.ts
git commit -m "feat(input): PlatformAdapter.input interface"
```

---

## Task 2: keymap — translate xdotool-style combo to Linux event codes

**Files:**
- Create: `src/main/input/keymap.ts`
- Test: `src/main/input/keymap.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/input/keymap.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { translateKeyCombo } from './keymap';

describe('translateKeyCombo', () => {
  it('translates Return as press + release', () => {
    expect(translateKeyCombo('Return')).toEqual([
      { code: 28, state: 1 },
      { code: 28, state: 0 },
    ]);
  });

  it('accepts Enter as alias of Return', () => {
    expect(translateKeyCombo('Enter')).toEqual(translateKeyCombo('Return'));
  });

  it('translates Control+S as ctrl down → s down → s up → ctrl up', () => {
    expect(translateKeyCombo('Control+S')).toEqual([
      { code: 29, state: 1 }, // ctrl down
      { code: 31, state: 1 }, // s down
      { code: 31, state: 0 }, // s up
      { code: 29, state: 0 }, // ctrl up
    ]);
  });

  it('translates Control+Alt+T with all four modifier transitions wrapping the key', () => {
    expect(translateKeyCombo('Control+Alt+T')).toEqual([
      { code: 29, state: 1 }, // ctrl down
      { code: 56, state: 1 }, // alt down
      { code: 20, state: 1 }, // t down
      { code: 20, state: 0 }, // t up
      { code: 56, state: 0 }, // alt up
      { code: 29, state: 0 }, // ctrl up
    ]);
  });

  it('accepts Meta as alias of Super', () => {
    expect(translateKeyCombo('Meta+L')).toEqual(translateKeyCombo('Super+L'));
  });

  it('translates F5', () => {
    expect(translateKeyCombo('F5')).toEqual([
      { code: 63, state: 1 },
      { code: 63, state: 0 },
    ]);
  });

  it('translates F12', () => {
    expect(translateKeyCombo('F12')).toEqual([
      { code: 88, state: 1 },
      { code: 88, state: 0 },
    ]);
  });

  it('translates arrow keys', () => {
    expect(translateKeyCombo('Up')).toEqual([{ code: 103, state: 1 }, { code: 103, state: 0 }]);
    expect(translateKeyCombo('Down')).toEqual([{ code: 108, state: 1 }, { code: 108, state: 0 }]);
    expect(translateKeyCombo('Left')).toEqual([{ code: 105, state: 1 }, { code: 105, state: 0 }]);
    expect(translateKeyCombo('Right')).toEqual([{ code: 106, state: 1 }, { code: 106, state: 0 }]);
  });

  it('translates Tab, Escape, Space, Backspace, Delete', () => {
    expect(translateKeyCombo('Tab')).toEqual([{ code: 15, state: 1 }, { code: 15, state: 0 }]);
    expect(translateKeyCombo('Escape')).toEqual([{ code: 1, state: 1 }, { code: 1, state: 0 }]);
    expect(translateKeyCombo('Space')).toEqual([{ code: 57, state: 1 }, { code: 57, state: 0 }]);
    expect(translateKeyCombo('Backspace')).toEqual([{ code: 14, state: 1 }, { code: 14, state: 0 }]);
    expect(translateKeyCombo('Delete')).toEqual([{ code: 111, state: 1 }, { code: 111, state: 0 }]);
  });

  it('translates a single lowercase letter (a, z)', () => {
    expect(translateKeyCombo('a')).toEqual([{ code: 30, state: 1 }, { code: 30, state: 0 }]);
    expect(translateKeyCombo('z')).toEqual([{ code: 44, state: 1 }, { code: 44, state: 0 }]);
  });

  it('translates a single digit (0, 9)', () => {
    expect(translateKeyCombo('0')).toEqual([{ code: 11, state: 1 }, { code: 11, state: 0 }]);
    expect(translateKeyCombo('9')).toEqual([{ code: 10, state: 1 }, { code: 10, state: 0 }]);
  });

  it('throws on unknown key', () => {
    expect(() => translateKeyCombo('NotAKey')).toThrow(/unknown key: NotAKey/);
  });

  it('throws on unknown modifier', () => {
    expect(() => translateKeyCombo('Hyper+A')).toThrow(/unknown key: Hyper/);
  });
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Create `src/main/input/keymap.ts`**

```ts
export interface KeyEvent {
  /** Linux input event code (from linux/input-event-codes.h). */
  code: number;
  /** 1 = press, 0 = release. */
  state: 0 | 1;
}

/**
 * Translate an xdotool-style key combo (e.g., "Control+S") into a sequence
 * of Linux input event press/release events. Modifiers are pressed in order,
 * then the key, then released in reverse order.
 */
export function translateKeyCombo(combo: string): KeyEvent[] {
  const tokens = combo.split('+').map((t) => t.trim());
  if (tokens.length === 0) throw new Error('empty key combo');

  const codes = tokens.map(tokenToCode);
  const modifiers = codes.slice(0, -1);
  const key = codes[codes.length - 1]!;

  const events: KeyEvent[] = [];
  for (const m of modifiers) events.push({ code: m, state: 1 });
  events.push({ code: key, state: 1 });
  events.push({ code: key, state: 0 });
  for (const m of [...modifiers].reverse()) events.push({ code: m, state: 0 });
  return events;
}

function tokenToCode(token: string): number {
  const direct = NAME_TO_CODE[token];
  if (direct !== undefined) return direct;
  const alias = ALIASES[token];
  if (alias !== undefined) {
    const aliasCode = NAME_TO_CODE[alias];
    if (aliasCode !== undefined) return aliasCode;
  }
  // Single lowercase letter or digit fallback.
  if (token.length === 1) {
    const ch = token.toLowerCase();
    const letterCode = LETTERS[ch];
    if (letterCode !== undefined) return letterCode;
    const digitCode = DIGITS[ch];
    if (digitCode !== undefined) return digitCode;
  }
  throw new Error(`unknown key: ${token}`);
}

const ALIASES: Record<string, string> = {
  Enter: 'Return',
  Meta: 'Super',
};

const NAME_TO_CODE: Record<string, number> = {
  // Modifiers
  Control: 29,
  Alt: 56,
  Shift: 42,
  Super: 125,
  // Named keys
  Return: 28,
  Tab: 15,
  Escape: 1,
  Space: 57,
  Backspace: 14,
  Delete: 111,
  // Arrows
  Up: 103,
  Down: 108,
  Left: 105,
  Right: 106,
  // Function keys
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  F11: 87,
  F12: 88,
};

const LETTERS: Record<string, number> = {
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36,
  k: 37, l: 38, m: 50, n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20,
  u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
};

const DIGITS: Record<string, number> = {
  '0': 11, '1': 2, '2': 3, '3': 4, '4': 5,
  '5': 6, '6': 7, '7': 8, '8': 9, '9': 10,
};
```

- [ ] **Step 4: Run, expect PASS**

Run: `npm run test -- src/main/input/keymap.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/main/input/keymap.ts src/main/input/keymap.test.ts
git commit -m "feat(input): keymap (xdotool-style combo → Linux event codes)"
```

---

## Task 3: executor — InputAction dispatch + delay

**Files:**
- Create: `src/main/input/executor.ts`
- Test: `src/main/input/executor.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/input/executor.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exec, type InputAction } from './executor';
import type { CursorPosition, PlatformAdapter, PlatformInput } from '../platform';

function makeFakeInput(overrides: Partial<PlatformInput> = {}): PlatformInput {
  return {
    cursorPosition: vi.fn(async (): Promise<CursorPosition> => ({ x: 100, y: 200 })),
    move: vi.fn(async () => {}),
    scroll: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    doubleClick: vi.fn(async () => {}),
    drag: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    key: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeAdapter(input: PlatformInput): PlatformAdapter {
  return {
    name: 'linux',
    detectDisplayServer: () => 'x11',
    defaultHotkey: () => 'Super+Space',
    shell: { spawnShell: () => ({} as never), composeEnv: () => ({}) },
    screenshot: { capture: vi.fn() as never },
    input,
  } as unknown as PlatformAdapter;
}

describe('exec', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cursorPosition returns adapter result, no delay applied', async () => {
    const input = makeFakeInput();
    const p = exec({ kind: 'cursorPosition' }, makeAdapter(input), 100);
    await vi.runAllTimersAsync();
    const r = await p;
    expect(input.cursorPosition).toHaveBeenCalled();
    expect(r).toEqual({ x: 100, y: 200 });
  });

  it('move dispatches with x/y and waits ≥ delayMs', async () => {
    const input = makeFakeInput();
    const adapter = makeAdapter(input);
    const p = exec({ kind: 'move', x: 50, y: 60 }, adapter, 100);
    // Adapter is called immediately; only the delay is pending.
    await Promise.resolve();
    expect(input.move).toHaveBeenCalledWith(50, 60);
    await vi.advanceTimersByTimeAsync(99);
    // Not resolved yet.
    let done = false;
    p.then(() => { done = true; });
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await p;
  });

  it('click dispatches with all args', async () => {
    const input = makeFakeInput();
    const p = exec({ kind: 'click', x: 10, y: 20, button: 'right' }, makeAdapter(input), 100);
    await vi.runAllTimersAsync();
    await p;
    expect(input.click).toHaveBeenCalledWith(10, 20, 'right');
  });

  it('doubleClick dispatches with all args', async () => {
    const input = makeFakeInput();
    const p = exec({ kind: 'doubleClick', x: 1, y: 2, button: 'left' }, makeAdapter(input), 100);
    await vi.runAllTimersAsync();
    await p;
    expect(input.doubleClick).toHaveBeenCalledWith(1, 2, 'left');
  });

  it('drag dispatches with all args', async () => {
    const input = makeFakeInput();
    const p = exec(
      { kind: 'drag', x1: 1, y1: 2, x2: 3, y2: 4, button: 'middle' },
      makeAdapter(input),
      100
    );
    await vi.runAllTimersAsync();
    await p;
    expect(input.drag).toHaveBeenCalledWith(1, 2, 3, 4, 'middle');
  });

  it('scroll dispatches with optional x/y', async () => {
    const input = makeFakeInput();
    const p = exec({ kind: 'scroll', dx: 0, dy: 5 }, makeAdapter(input), 100);
    await vi.runAllTimersAsync();
    await p;
    expect(input.scroll).toHaveBeenCalledWith(0, 5, undefined, undefined);
  });

  it('type dispatches with text', async () => {
    const input = makeFakeInput();
    const p = exec({ kind: 'type', text: 'hello' }, makeAdapter(input), 100);
    await vi.runAllTimersAsync();
    await p;
    expect(input.type).toHaveBeenCalledWith('hello');
  });

  it('key dispatches with combo', async () => {
    const input = makeFakeInput();
    const p = exec({ kind: 'key', combo: 'Control+S' }, makeAdapter(input), 100);
    await vi.runAllTimersAsync();
    await p;
    expect(input.key).toHaveBeenCalledWith('Control+S');
  });

  it('adapter errors propagate', async () => {
    const input = makeFakeInput({
      click: vi.fn(async () => { throw new Error('boom'); }),
    });
    const p = exec({ kind: 'click', x: 1, y: 2, button: 'left' }, makeAdapter(input), 100);
    await vi.runAllTimersAsync();
    await expect(p).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Create `src/main/input/executor.ts`**

```ts
import type { CursorPosition, MouseButton, PlatformAdapter } from '../platform';

export type InputAction =
  | { kind: 'cursorPosition' }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'scroll'; dx: number; dy: number; x?: number; y?: number }
  | { kind: 'click'; x: number; y: number; button: MouseButton }
  | { kind: 'doubleClick'; x: number; y: number; button: MouseButton }
  | { kind: 'drag'; x1: number; y1: number; x2: number; y2: number; button: MouseButton }
  | { kind: 'type'; text: string }
  | { kind: 'key'; combo: string };

export async function exec(
  action: InputAction,
  adapter: PlatformAdapter,
  delayMs: number
): Promise<unknown> {
  const input = adapter.input;
  switch (action.kind) {
    case 'cursorPosition': {
      const pos: CursorPosition = await input.cursorPosition();
      return pos;
    }
    case 'move':
      await input.move(action.x, action.y);
      break;
    case 'scroll':
      await input.scroll(action.dx, action.dy, action.x, action.y);
      break;
    case 'click':
      await input.click(action.x, action.y, action.button);
      break;
    case 'doubleClick':
      await input.doubleClick(action.x, action.y, action.button);
      break;
    case 'drag':
      await input.drag(action.x1, action.y1, action.x2, action.y2, action.button);
      break;
    case 'type':
      await input.type(action.text);
      break;
    case 'key':
      await input.key(action.combo);
      break;
  }
  if (delayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
  return undefined;
}
```

- [ ] **Step 4: Run, expect PASS (9 tests)**

- [ ] **Step 5: Commit**

```bash
git add src/main/input/executor.ts src/main/input/executor.test.ts
git commit -m "feat(input): executor (action dispatch + post-action delay)"
```

---

## Task 4: setup-check — probe ydotool + auto-enable ydotoold

**Files:**
- Create: `src/main/input/setup-check.ts`
- Test: `src/main/input/setup-check.test.ts`

Uses `node:child_process.exec` (promisified). Tests mock it.

- [ ] **Step 1: Write the failing test**

`src/main/input/setup-check.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execMock = vi.fn();

vi.mock('node:child_process', () => ({
  exec: (cmd: string, cb: (err: unknown, stdout: string, stderr: string) => void) => {
    execMock(cmd).then(
      (r: { stdout: string; stderr: string }) => cb(null, r.stdout, r.stderr),
      (err: NodeJS.ErrnoException) => cb(err, '', err.message)
    );
  },
}));

import { checkYdotoolReady, _resetCacheForTesting } from './setup-check';

beforeEach(() => {
  execMock.mockReset();
  _resetCacheForTesting();
});

afterEach(() => {
  vi.useRealTimers();
});

function setExec(handler: (cmd: string) => Promise<{ stdout: string; stderr: string }>) {
  execMock.mockImplementation((cmd: string) => handler(cmd));
}

describe('checkYdotoolReady', () => {
  it('returns failure with install hint when ydotool is missing', async () => {
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      throw new Error(`unexpected: ${cmd}`);
    });
    const r = await checkYdotoolReady();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not installed/i);
    expect(r.hint).toMatch(/dnf install ydotool/);
  });

  it('returns success when ydotool installed and ydotoold active', async () => {
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) return { stdout: '/usr/bin/ydotool\n', stderr: '' };
      if (cmd.includes('is-active ydotoold')) return { stdout: 'active\n', stderr: '' };
      throw new Error(`unexpected: ${cmd}`);
    });
    const r = await checkYdotoolReady();
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.hint).toBeNull();
  });

  it('auto-runs enable+start when ydotoold is inactive, then succeeds if it becomes active', async () => {
    vi.useFakeTimers();
    let activeNow = false;
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) return { stdout: '/usr/bin/ydotool\n', stderr: '' };
      if (cmd.includes('is-active ydotoold')) {
        return { stdout: activeNow ? 'active\n' : 'inactive\n', stderr: '' };
      }
      if (cmd.includes('enable --now ydotoold')) {
        activeNow = true;
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected: ${cmd}`);
    });
    const p = checkYdotoolReady();
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.ok).toBe(true);
  });

  it('returns failure if auto-enable still leaves it inactive', async () => {
    vi.useFakeTimers();
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) return { stdout: '/usr/bin/ydotool\n', stderr: '' };
      if (cmd.includes('is-active ydotoold')) return { stdout: 'inactive\n', stderr: '' };
      if (cmd.includes('enable --now ydotoold')) return { stdout: '', stderr: '' };
      throw new Error(`unexpected: ${cmd}`);
    });
    const p = checkYdotoolReady();
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not be started/i);
    expect(r.hint).toMatch(/systemctl --user enable --now ydotoold/);
  });

  it('caches success across calls (exec called only twice total)', async () => {
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) return { stdout: '/usr/bin/ydotool\n', stderr: '' };
      if (cmd.includes('is-active ydotoold')) return { stdout: 'active\n', stderr: '' };
      throw new Error(`unexpected: ${cmd}`);
    });
    await checkYdotoolReady();
    await checkYdotoolReady();
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache failure (re-probes on next call)', async () => {
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      throw new Error(`unexpected: ${cmd}`);
    });
    await checkYdotoolReady();
    await checkYdotoolReady();
    expect(execMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Create `src/main/input/setup-check.ts`**

```ts
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCb);

export interface SetupResult {
  ok: boolean;
  reason: string | null;
  hint: string | null;
}

let cached: SetupResult | null = null;

const INSTALL_HINT =
  'Install on Fedora/Bazzite: sudo dnf install ydotool';
const START_HINT =
  'Try manually: systemctl --user enable --now ydotoold';

export async function checkYdotoolReady(): Promise<SetupResult> {
  if (cached && cached.ok) return cached;

  try {
    await exec('which ydotool');
  } catch {
    const r: SetupResult = {
      ok: false,
      reason: 'ydotool is not installed',
      hint: INSTALL_HINT,
    };
    cached = null;
    return r;
  }

  const isActive = await probeActive();
  if (isActive) {
    cached = { ok: true, reason: null, hint: null };
    return cached;
  }

  // Auto-enable and re-poll.
  try {
    await exec('systemctl --user enable --now ydotoold');
  } catch {
    // Continue to the re-poll; the enable attempt may have raced.
  }
  await sleep(500);

  if (await probeActive()) {
    cached = { ok: true, reason: null, hint: null };
    return cached;
  }

  cached = null;
  return {
    ok: false,
    reason: 'ydotoold service is not running and could not be started automatically',
    hint: START_HINT,
  };
}

async function probeActive(): Promise<boolean> {
  try {
    const { stdout } = await exec('systemctl --user is-active ydotoold');
    return stdout.trim() === 'active';
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test-only: reset the cached result. */
export function _resetCacheForTesting(): void {
  cached = null;
}
```

- [ ] **Step 4: Run, expect PASS (6 tests)**

Run: `npm run test -- src/main/input/setup-check.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/main/input/setup-check.ts src/main/input/setup-check.test.ts
git commit -m "feat(input): setup-check (probe ydotool + auto-enable ydotoold)"
```

---

## Task 5: LinuxAdapter ydotool impl

**Files:**
- Modify: `src/main/platform/linux.ts`

Closes the typecheck gap from Task 1.

- [ ] **Step 1: Read `src/main/platform/linux.ts`**

Existing class has `name`, `detectDisplayServer`, `defaultHotkey`, `shell`, `screenshot`. Adding `input`.

- [ ] **Step 2: Add input impl alongside existing members**

Add imports if not already present:

```ts
import type {
  CaptureOptions,
  CaptureResult,
  CursorPosition,
  DisplayServer,
  MonitorInfo,
  MouseButton,
  PlatformAdapter,
  PlatformInput,
  ShellChild,
} from './index';
```

Add to the class body alongside `screenshot`:

```ts
  input: PlatformInput = {
    cursorPosition: async (): Promise<CursorPosition> => {
      // ydotool can't read cursor position. Use Electron's screen API and
      // translate to active-monitor-relative coords.
      const point = screen.getCursorScreenPoint();
      const monitor = this.activeMonitor();
      return { x: point.x - monitor.x, y: point.y - monitor.y };
    },
    move: async (x: number, y: number): Promise<void> => {
      await this.ensureInputReady();
      const { absX, absY } = this.absolute(x, y);
      await this.runYdotool(['mousemove', '--absolute', String(absX), String(absY)]);
    },
    scroll: async (dx: number, dy: number, x?: number, y?: number): Promise<void> => {
      await this.ensureInputReady();
      if (x !== undefined && y !== undefined) {
        const { absX, absY } = this.absolute(x, y);
        await this.runYdotool(['mousemove', '--absolute', String(absX), String(absY)]);
      }
      if (dy !== 0) {
        await this.runYdotool(['mousemove', '--wheel', '0', String(dy)]);
      }
      if (dx !== 0) {
        await this.runYdotool(['mousemove', '--hwheel', String(dx), '0']);
      }
    },
    click: async (x: number, y: number, button: MouseButton): Promise<void> => {
      await this.ensureInputReady();
      const { absX, absY } = this.absolute(x, y);
      await this.runYdotool(['mousemove', '--absolute', String(absX), String(absY)]);
      await this.runYdotool(['click', BUTTON_CODE[button]]);
    },
    doubleClick: async (x: number, y: number, button: MouseButton): Promise<void> => {
      await this.ensureInputReady();
      const { absX, absY } = this.absolute(x, y);
      await this.runYdotool(['mousemove', '--absolute', String(absX), String(absY)]);
      await this.runYdotool(['click', BUTTON_CODE[button]]);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      await this.runYdotool(['click', BUTTON_CODE[button]]);
    },
    drag: async (x1: number, y1: number, x2: number, y2: number, button: MouseButton): Promise<void> => {
      await this.ensureInputReady();
      const a = this.absolute(x1, y1);
      const b = this.absolute(x2, y2);
      await this.runYdotool(['mousemove', '--absolute', String(a.absX), String(a.absY)]);
      await this.runYdotool(['mousedown', BUTTON_LOW[button]]);
      await this.runYdotool(['mousemove', '--absolute', String(b.absX), String(b.absY)]);
      await this.runYdotool(['mouseup', BUTTON_LOW[button]]);
    },
    type: async (text: string): Promise<void> => {
      await this.ensureInputReady();
      await this.runYdotoolWithStdin(['type', '--'], text);
    },
    key: async (combo: string): Promise<void> => {
      await this.ensureInputReady();
      const events = translateKeyCombo(combo);
      const args = ['key', ...events.map((e) => `${e.code}:${e.state}`)];
      await this.runYdotool(args);
    },
  };

  private absolute(x: number, y: number): { absX: number; absY: number } {
    const monitor = this.activeMonitor();
    return { absX: monitor.x + x, absY: monitor.y + y };
  }

  private async ensureInputReady(): Promise<void> {
    const r = await checkYdotoolReady();
    if (!r.ok) {
      throw new Error(`${r.reason}\n\n${r.hint}`);
    }
  }

  private runYdotool(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn('ydotool', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) return resolve();
        if (/permission denied|EACCES/i.test(stderr)) {
          reject(new Error(
            'Permission denied — add your user to the input group:\n' +
            'sudo usermod -aG input $USER\n' +
            '(then log out and back in)'
          ));
          return;
        }
        reject(new Error(`ydotool failed: ${stderr.trim() || `exit ${code}`}`));
      });
    });
  }

  private runYdotoolWithStdin(args: string[], stdinText: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn('ydotool', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) return resolve();
        if (/permission denied|EACCES/i.test(stderr)) {
          reject(new Error(
            'Permission denied — add your user to the input group:\n' +
            'sudo usermod -aG input $USER\n' +
            '(then log out and back in)'
          ));
          return;
        }
        reject(new Error(`ydotool failed: ${stderr.trim() || `exit ${code}`}`));
      });
      child.stdin.end(stdinText);
    });
  }
```

Add the supporting imports / constants near the top of the file:

```ts
import { translateKeyCombo } from '../input/keymap';
import { checkYdotoolReady } from '../input/setup-check';
```

And the button code maps (place near the top of the file, after imports):

```ts
const BUTTON_CODE: Record<MouseButton, string> = {
  left: '0xC0',
  right: '0xC1',
  middle: '0xC2',
};

const BUTTON_LOW: Record<MouseButton, string> = {
  left: '0x40',
  right: '0x41',
  middle: '0x42',
};
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run existing platform tests**

Run: `npm run test -- src/main/platform/platform.test.ts`
Expected: PASS (4 existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/platform/linux.ts
git commit -m "feat(input): LinuxAdapter.input ydotool impl"
```

---

## Task 6: buildInputTools + tools test additions

**Files:**
- Modify: `src/main/agent/tools.ts`
- Modify: `src/main/agent/tools.test.ts`

- [ ] **Step 1: Read `src/main/agent/tools.ts`**

Note `OttoTool`, the existing `stubTools`, `buildShellTools`, `buildScreenshotTool`. Adding sibling `buildInputTools`.

- [ ] **Step 2: Append to `src/main/agent/tools.ts`**

At the bottom of the file:

```ts
const coord = z.number().int().nonnegative();
const buttonSchema = z.enum(['left', 'right', 'middle']).default('left');
const delayMs = z.number().int().nonnegative().optional();

const cursorPositionSchema = z.object({});
const moveSchema = z.object({ x: coord, y: coord });
const scrollSchema = z.object({
  dx: z.number().int(),
  dy: z.number().int(),
  x: coord.optional(),
  y: coord.optional(),
});
const clickSchema = z.object({ x: coord, y: coord, button: buttonSchema, delay_ms: delayMs });
const doubleClickSchema = z.object({ x: coord, y: coord, button: buttonSchema });
const dragSchema = z.object({
  x1: coord, y1: coord, x2: coord, y2: coord, button: buttonSchema,
});
const typeSchema = z.object({ text: z.string(), delay_ms: delayMs });
const keySchema = z.object({ combo: z.string(), delay_ms: delayMs });

const HANDLER_THROW = 'must be invoked via the SDK handler';

export function buildInputTools(): OttoTool[] {
  return [
    {
      name: 'get_cursor_position',
      description: 'Return the current cursor position in active-monitor pixels: { x, y }.',
      actionClass: 'read',
      schema: cursorPositionSchema,
      async run(_input) { throw new Error(`get_cursor_position ${HANDLER_THROW}`); },
    },
    {
      name: 'move',
      description: 'Move the cursor to (x, y) in active-monitor pixels.',
      actionClass: 'reversible',
      schema: moveSchema,
      async run(_input) { throw new Error(`move ${HANDLER_THROW}`); },
    },
    {
      name: 'scroll',
      description: 'Scroll by (dx, dy). Optional (x, y) moves the cursor there first.',
      actionClass: 'reversible',
      schema: scrollSchema,
      async run(_input) { throw new Error(`scroll ${HANDLER_THROW}`); },
    },
    {
      name: 'click',
      description: 'Click at (x, y) in active-monitor pixels. button: left|right|middle. Optional delay_ms.',
      actionClass: 'destructive',
      schema: clickSchema,
      async run(_input) { throw new Error(`click ${HANDLER_THROW}`); },
    },
    {
      name: 'double_click',
      description: 'Double-click at (x, y) in active-monitor pixels.',
      actionClass: 'destructive',
      schema: doubleClickSchema,
      async run(_input) { throw new Error(`double_click ${HANDLER_THROW}`); },
    },
    {
      name: 'drag',
      description: 'Drag from (x1, y1) to (x2, y2) with the given button held down.',
      actionClass: 'destructive',
      schema: dragSchema,
      async run(_input) { throw new Error(`drag ${HANDLER_THROW}`); },
    },
    {
      name: 'type',
      description: 'Type literal text into the focused window. Optional delay_ms.',
      actionClass: 'destructive',
      schema: typeSchema,
      async run(_input) { throw new Error(`type ${HANDLER_THROW}`); },
    },
    {
      name: 'key',
      description:
        'Send a key combo to the focused window (e.g. "Control+S", "F5", "Return"). xdotool-style naming.',
      actionClass: 'destructive',
      schema: keySchema,
      async run(_input) { throw new Error(`key ${HANDLER_THROW}`); },
    },
  ];
}
```

- [ ] **Step 3: Append tests to `src/main/agent/tools.test.ts`**

```ts
import { buildInputTools } from './tools';

describe('buildInputTools', () => {
  it('returns 8 tools with expected names', () => {
    const names = buildInputTools().map((t) => t.name).sort();
    expect(names).toEqual([
      'click', 'double_click', 'drag', 'get_cursor_position',
      'key', 'move', 'scroll', 'type',
    ]);
  });

  it('action classes match the matrix', () => {
    const byName = new Map(buildInputTools().map((t) => [t.name, t]));
    expect(byName.get('get_cursor_position')!.actionClass).toBe('read');
    expect(byName.get('move')!.actionClass).toBe('reversible');
    expect(byName.get('scroll')!.actionClass).toBe('reversible');
    expect(byName.get('click')!.actionClass).toBe('destructive');
    expect(byName.get('double_click')!.actionClass).toBe('destructive');
    expect(byName.get('drag')!.actionClass).toBe('destructive');
    expect(byName.get('type')!.actionClass).toBe('destructive');
    expect(byName.get('key')!.actionClass).toBe('destructive');
  });

  it('click schema accepts coords + optional button/delay', () => {
    const t = buildInputTools().find((t) => t.name === 'click')!;
    expect(t.schema.parse({ x: 10, y: 20 })).toEqual({ x: 10, y: 20, button: 'left' });
    expect(t.schema.parse({ x: 10, y: 20, button: 'right', delay_ms: 50 })).toEqual({
      x: 10, y: 20, button: 'right', delay_ms: 50,
    });
  });

  it('click schema rejects negative coords', () => {
    const t = buildInputTools().find((t) => t.name === 'click')!;
    expect(() => t.schema.parse({ x: -1, y: 0 })).toThrow();
  });

  it('type schema requires text', () => {
    const t = buildInputTools().find((t) => t.name === 'type')!;
    expect(t.schema.parse({ text: 'hi' })).toEqual({ text: 'hi' });
    expect(() => t.schema.parse({})).toThrow();
  });

  it('key schema requires combo string', () => {
    const t = buildInputTools().find((t) => t.name === 'key')!;
    expect(t.schema.parse({ combo: 'Control+S' })).toEqual({ combo: 'Control+S' });
    expect(() => t.schema.parse({})).toThrow();
  });

  it('scroll allows negative deltas', () => {
    const t = buildInputTools().find((t) => t.name === 'scroll')!;
    expect(t.schema.parse({ dx: -5, dy: 3 })).toEqual({ dx: -5, dy: 3 });
  });

  it('drag requires all four coords', () => {
    const t = buildInputTools().find((t) => t.name === 'drag')!;
    expect(() => t.schema.parse({ x1: 1, y1: 2 })).toThrow();
    expect(t.schema.parse({ x1: 1, y1: 2, x2: 3, y2: 4 })).toEqual({
      x1: 1, y1: 2, x2: 3, y2: 4, button: 'left',
    });
  });

  it('direct run throws for every tool', async () => {
    for (const t of buildInputTools()) {
      const validInput = (() => {
        switch (t.name) {
          case 'get_cursor_position': return {};
          case 'move': return { x: 0, y: 0 };
          case 'scroll': return { dx: 0, dy: 0 };
          case 'click': return { x: 0, y: 0 };
          case 'double_click': return { x: 0, y: 0 };
          case 'drag': return { x1: 0, y1: 0, x2: 0, y2: 0 };
          case 'type': return { text: '' };
          case 'key': return { combo: 'a' };
          default: throw new Error('unhandled');
        }
      })();
      await expect(t.run(validInput)).rejects.toThrow(/SDK handler/);
    }
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- src/main/agent/tools.test.ts`
Expected: existing tests + 9 new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/tools.ts src/main/agent/tools.test.ts
git commit -m "feat(input): buildInputTools (8 tools with matrix-mapped classes)"
```

---

## Task 7: SDK handler dispatch for input tools

**Files:**
- Modify: `src/main/agent/sdk-client.ts`

- [ ] **Step 1: Read `src/main/agent/sdk-client.ts`**

Find the existing tool list + `allowedTools` construction, and the wrapped MCP handler that already special-cases `shell_spawn` and `screenshot`. We're adding input tools to both lists, plus a dispatch branch.

- [ ] **Step 2: Add input tools to the per-turn list and allowedTools**

Find the `allTools` declaration inside `buildOttoMcpServer`:

```ts
const allTools: OttoTool[] = [
  ...stubTools,
  ...buildShellTools(ctx.getRegistry),
  buildScreenshotTool(),
];
```

Update to:

```ts
const allTools: OttoTool[] = [
  ...stubTools,
  ...buildShellTools(ctx.getRegistry),
  buildScreenshotTool(),
  ...buildInputTools(),
];
```

Find `allToolsForAllow` inside `createRealSdkClient`:

```ts
const allToolsForAllow: OttoTool[] = [
  ...stubTools,
  ...buildShellTools(deps.getRegistry),
  buildScreenshotTool(),
];
```

Update to:

```ts
const allToolsForAllow: OttoTool[] = [
  ...stubTools,
  ...buildShellTools(deps.getRegistry),
  buildScreenshotTool(),
  ...buildInputTools(),
];
```

Update the import line:

```ts
import { buildInputTools, buildScreenshotTool, buildShellTools, stubTools, type OttoTool } from './tools';
```

Add new imports for the input pipeline:

```ts
import { exec as execInput, type InputAction } from '../input/executor';
```

(`getPlatformAdapter` is already imported.)

- [ ] **Step 3: Add the dispatch branch in the wrapped handler**

In the wrapped tool handler, alongside the existing `if (t.name === 'shell_spawn') { ... }` and `if (t.name === 'screenshot') { ... }` blocks, add:

```ts
const INPUT_TOOL_NAMES = new Set([
  'get_cursor_position', 'move', 'scroll', 'click', 'double_click',
  'drag', 'type', 'key',
]);

if (INPUT_TOOL_NAMES.has(t.name)) {
  const action = toInputAction(t.name, args);
  const delayMs = (args as { delay_ms?: number }).delay_ms ?? 100;
  const result = await execInput(action, getPlatformAdapter(), delayMs);
  return {
    content: [
      {
        type: 'text' as const,
        text: result === undefined ? 'ok' : JSON.stringify(result),
      },
    ],
  };
}
```

`INPUT_TOOL_NAMES` and `toInputAction` go at the top of the file (after imports, before the `buildOttoMcpServer` function):

```ts
const INPUT_TOOL_NAMES = new Set([
  'get_cursor_position', 'move', 'scroll', 'click', 'double_click',
  'drag', 'type', 'key',
]);

function toInputAction(name: string, args: unknown): InputAction {
  const a = args as Record<string, unknown>;
  switch (name) {
    case 'get_cursor_position':
      return { kind: 'cursorPosition' };
    case 'move':
      return { kind: 'move', x: a.x as number, y: a.y as number };
    case 'scroll':
      return {
        kind: 'scroll',
        dx: a.dx as number,
        dy: a.dy as number,
        x: a.x as number | undefined,
        y: a.y as number | undefined,
      };
    case 'click':
      return {
        kind: 'click',
        x: a.x as number,
        y: a.y as number,
        button: (a.button as 'left' | 'right' | 'middle') ?? 'left',
      };
    case 'double_click':
      return {
        kind: 'doubleClick',
        x: a.x as number,
        y: a.y as number,
        button: (a.button as 'left' | 'right' | 'middle') ?? 'left',
      };
    case 'drag':
      return {
        kind: 'drag',
        x1: a.x1 as number, y1: a.y1 as number,
        x2: a.x2 as number, y2: a.y2 as number,
        button: (a.button as 'left' | 'right' | 'middle') ?? 'left',
      };
    case 'type':
      return { kind: 'type', text: a.text as string };
    case 'key':
      return { kind: 'key', combo: a.combo as string };
    default:
      throw new Error(`unknown input tool: ${name}`);
  }
}
```

- [ ] **Step 4: Update `SYSTEM_PROMPT` to advertise the 8 new tools**

Find the existing `SYSTEM_PROMPT` array and add lines for the input tools after the `screenshot` line:

```ts
  '- get_cursor_position(): return the cursor position {x, y} in active-monitor pixels.',
  '- move(x, y): move the cursor to the given monitor-relative position.',
  '- scroll(dx, dy, x?, y?): scroll by (dx, dy); optional (x, y) moves cursor first.',
  '- click(x, y, button?, delay_ms?): left/right/middle click at the position.',
  '- double_click(x, y, button?): double-click at the position.',
  '- drag(x1, y1, x2, y2, button?): drag from start to end.',
  '- type(text, delay_ms?): type literal text into the focused window.',
  '- key(combo, delay_ms?): send a key combo (xdotool-style: "Control+S", "F5", "Return").',
```

- [ ] **Step 5: Typecheck + tests**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run test`
Expected: full suite PASS (existing tests + new ones from Tasks 2, 3, 4, 6).

- [ ] **Step 6: Commit**

```bash
git add src/main/agent/sdk-client.ts
git commit -m "feat(input): SDK handler dispatches input tools through executor"
```

---

## Task 8: Manual verification

**Files:** none — runtime smoke.

- [ ] **Step 1: Pre-flight setup**

Confirm ydotool is installed and your user is in the `input` group:

```bash
which ydotool && groups | grep -q input && echo OK
```

If `which` fails:

```bash
sudo dnf install ydotool
```

If `groups | grep input` fails:

```bash
sudo usermod -aG input $USER
# log out + back in
```

Otto will auto-enable ydotoold on first input attempt; you don't need to start it manually.

- [ ] **Step 2: Start the dev app**

```bash
npm run dev
```

- [ ] **Step 3: Walk the checklist**

In each case, focus a benign window (e.g., an empty editor or a terminal you don't mind getting typed-into) before asking.

- [ ] In balanced mode, `"use the type tool to type 'hello' into the focused window"` — approval card, **Approve for session**, "hello" appears wherever your focus is. The ydotoold auto-start should happen transparently on this first call.
- [ ] `"press Control+T"` — opens a new tab in your focused browser/terminal.
- [ ] `"click at 500, 500"` — cursor moves there and clicks.
- [ ] `"scroll down by 5"` — focused window scrolls down.
- [ ] `"drag from 100,100 to 400,400"` — visible drag in the focused window.
- [ ] `"get cursor position"` — no approval (read class), returns `{x, y}`.
- [ ] In strict mode (via the mode badge), `"move cursor to 200,200"` — approval card (reversible prompts in strict). `"get cursor position"` — still no prompt (read).
- [ ] `systemctl --user stop ydotoold && systemctl --user disable ydotoold` then in Otto type a prompt that triggers any input tool — setup-check auto-starts ydotoold, action proceeds. After: `systemctl --user is-active ydotoold` shows `active`.
- [ ] Temporarily remove yourself from the `input` group (`sudo gpasswd -d $USER input`, log out + back in), retry a click — error card shows the exact `usermod` hint. (Re-add yourself afterward: `sudo usermod -aG input $USER`.)

- [ ] **Step 4: Commit any fixes from the walkthrough**

Per-fix commits as needed.

---

## Self-Review Notes

Mapped each spec section to tasks:
- **Goals (8 tools, classes, monitor-relative coords, delay, key naming, setup auto-recovery)** → Tasks 1 (interface), 2 (keymap), 4 (setup-check), 5 (linux impl), 6 (tools), 7 (SDK dispatch).
- **Non-Goals** → enforced by absence (no input bundling, no portal RemoteDesktop, no Otto-window detection).
- **Architecture (input module + adapter namespace + handler intercept)** → Tasks 1 / 3 / 5 / 6 / 7.
- **Components (keymap, setup-check, executor, LinuxAdapter.input, buildInputTools, SDK dispatch)** → Tasks 2 / 4 / 3 / 5 / 6 / 7.
- **Data flow (typical click; setup auto-recovery)** → Task 5 (adapter call ordering + `ensureInputReady`); Task 4 (auto-enable logic).
- **Error handling table (missing binary, inactive daemon, EACCES, off-monitor, unknown key, etc.)** → Tasks 4 (setup), 5 (EACCES detection, off-monitor would be added in the adapter — see note below), 2 (unknown key), 6 (schema validation).
- **Testing strategy (unit only; no integration)** → Tasks 2, 3, 4, 6.
- **Manual verification checklist** → Task 8.

**Gap noted and patched:** the spec mentions explicit validation that coords are within monitor bounds, but neither Task 5 nor Task 6 implements it (zod only checks ≥ 0). For v1, off-monitor coords just produce a cursor-clamped-or-no-op behavior at the OS level — ydotool happily accepts out-of-bounds coords and the compositor clamps. Adding explicit validation is one-line cleanup; not blocking. If it becomes an issue, add a check in `ensureInputReady` or per-method in the adapter.

No placeholders. Method names cross-checked: `translateKeyCombo`, `KeyEvent`, `InputAction`, `exec`, `checkYdotoolReady`, `_resetCacheForTesting`, `SetupResult`, `PlatformInput`, `MouseButton`, `CursorPosition`, `INPUT_TOOL_NAMES`, `toInputAction`, `buildInputTools`, `BUTTON_CODE`, `BUTTON_LOW`, `runYdotool`, `runYdotoolWithStdin`, `ensureInputReady`, `absolute`, `activeMonitor`.

Known seams documented inline:
- Task 1 leaves typecheck broken; Task 5 closes it.
- Task 5's drag uses ydotool's `mousedown`/`mouseup` with low-byte codes (`0x40`/`0x41`/`0x42`) — verify against the installed ydotool's expected encoding. If it differs, tune in Task 5.
- ydotool's exact flag spelling for `--wheel`/`--hwheel` is verified at implementation time; recent versions of ydotool support this form.
