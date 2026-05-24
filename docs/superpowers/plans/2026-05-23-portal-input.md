# Portal-Based Mouse Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace xdotool for mouse input with the XDG Desktop Portal `RemoteDesktop` interface so Otto can click, move, scroll, and drag against native Wayland windows (not just XWayland). Keyboard input stays on xdotool — out of scope.

**Architecture:** A new `src/main/input/portal.ts` module owns a D-Bus session bus connection, the portal `RemoteDesktop` session handle, and persistence of a `restore_token` so the user's permission grant survives across launches. Lazy handshake on first input call. `linux.ts` mouse methods delegate to it via a dependency-injected factory. Settings panel exposes a revoke action.

**Tech Stack:** TypeScript, Electron, `dbus-next` (new dep), Vitest, React (settings UI).

**Reference spec:** `docs/superpowers/specs/2026-05-23-portal-input-design.md`

---

## File map

**New:**
- `src/main/input/portal.ts` — D-Bus connection, handshake, dispatch.
- `src/main/input/portal.test.ts` — bus-stub tests.
- `src/renderer/components/settings/RemoteDesktopSection.tsx`
- `src/renderer/components/settings/RemoteDesktopSection.test.tsx`

**Modified:**
- `package.json` — add `dbus-next`.
- `src/main/platform/linux.ts` — five mouse methods delegate to `portalInput`. `ensureXdotool` removed from those five (kept on `type`/`key`).
- `src/shared/ipc-contract.ts` — `remoteDesktop.status` and `remoteDesktop.revoke` channels.
- `src/main/ipc/handlers.ts` — handlers for the two channels.
- `src/renderer/components/settings/SettingsNav.ts` — add a Remote desktop entry under General.
- `src/renderer/SettingsApp.tsx` — `renderSubsection` branch for the new entry.
- `src/main/agent/sdk-client.ts` — delete the obsolete "Cursor-warp tip" line from `SYSTEM_PROMPT`.

---

## Task 1: Install `dbus-next` + portal module skeleton

We add the dep first so subsequent TDD steps can import the real `MessageBus` type. The module exports only types + the empty `createPortalInput` factory here — Task 2 fills in the handshake + dispatch behind tests.

**Files:**
- Modify: `package.json` (deps)
- Create: `src/main/input/portal.ts` (skeleton)

- [ ] **Step 1: Install `dbus-next`**

```bash
npm install dbus-next
```

This adds `dbus-next` (a pure-JS D-Bus client, MIT, no native bindings) to `dependencies` in `package.json`.

- [ ] **Step 2: Create the skeleton file**

Create `src/main/input/portal.ts`:

```ts
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
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/main/input/portal.ts
git commit -m "$(cat <<'EOF'
feat(input): scaffold portal input module + add dbus-next dep

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Portal handshake + event dispatch (TDD)

**Files:**
- Modify: `src/main/input/portal.ts`
- Create: `src/main/input/portal.test.ts`

This is the meat of the work. We write a stub `MessageBus` that records D-Bus calls and lets tests script `Response` signals, then build the real implementation against it.

- [ ] **Step 1: Write the failing tests**

Create `src/main/input/portal.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createPortalInput, type InputHandle } from './portal';

// ---- Bus stub --------------------------------------------------------------

interface MethodCall {
  iface: string;
  member: string;
  args: unknown[];
}

class StubInterface extends EventEmitter {
  constructor(public iface: string, public log: MethodCall[]) {
    super();
  }
  // dbus-next interfaces expose methods as direct properties; we proxy them
  // via a generic call() that tests use to script responses.
  call(member: string, ...args: unknown[]): Promise<unknown> {
    this.log.push({ iface: this.iface, member, args });
    const handler = this.scripted.get(member);
    if (!handler) throw new Error(`no script for ${this.iface}.${member}`);
    return handler(args);
  }
  private scripted = new Map<string, (args: unknown[]) => Promise<unknown>>();
  script(member: string, fn: (args: unknown[]) => Promise<unknown>) {
    this.scripted.set(member, fn);
  }
}

class StubBus {
  log: MethodCall[] = [];
  iface = new StubInterface('org.freedesktop.portal.RemoteDesktop', this.log);
  requestIfaces = new Map<string, StubInterface>();

  async getProxyObject(_serviceName: string, objectPath: string) {
    if (objectPath === '/org/freedesktop/portal/desktop') {
      return {
        getInterface: (_name: string) => this.iface as unknown,
      };
    }
    // Request object path — return an interface stubbed for signal emission.
    let req = this.requestIfaces.get(objectPath);
    if (!req) {
      req = new StubInterface('org.freedesktop.portal.Request', this.log);
      this.requestIfaces.set(objectPath, req);
    }
    return {
      getInterface: (_name: string) => req as unknown,
    };
  }

  /** Emit a Response signal on the request object whose path matches `token`. */
  emitResponse(handleToken: string, code: number, results: Record<string, unknown>) {
    const objectPath = `/org/freedesktop/portal/desktop/request/_/${handleToken}`;
    const req = this.requestIfaces.get(objectPath);
    if (!req) throw new Error(`no request iface for ${objectPath}`);
    req.emit('Response', code, results);
  }
}

// ---- Helpers ---------------------------------------------------------------

let dir: string;
let bus: StubBus;
let getCursor: () => { x: number; y: number };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-portal-'));
  bus = new StubBus();
  getCursor = () => ({ x: 100, y: 100 });
});

function build(): InputHandle {
  return createPortalInput({ configDir: dir, bus: bus as unknown as import('dbus-next').MessageBus, getCursor });
}

function cleanup() {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Script the three-step handshake to succeed. Returns the restore_token
 * the stubbed `Start` will hand back so tests can assert persistence.
 */
function scriptHandshakeOK(restoreToken = 'tok-abc'): void {
  bus.iface.script('CreateSession', async (args) => {
    const opts = args[0] as { handle_token: { value: string } };
    const handleToken = opts.handle_token.value;
    queueMicrotask(() => {
      bus.emitResponse(handleToken, 0, {
        session_handle: { signature: 'o', value: '/org/freedesktop/portal/desktop/session/_/s1' },
      });
    });
    return `/org/freedesktop/portal/desktop/request/_/${handleToken}`;
  });
  bus.iface.script('SelectDevices', async (args) => {
    const opts = args[1] as { handle_token: { value: string } };
    const handleToken = opts.handle_token.value;
    queueMicrotask(() => bus.emitResponse(handleToken, 0, {}));
    return `/org/freedesktop/portal/desktop/request/_/${handleToken}`;
  });
  bus.iface.script('Start', async (args) => {
    const opts = args[2] as { handle_token: { value: string } };
    const handleToken = opts.handle_token.value;
    queueMicrotask(() =>
      bus.emitResponse(handleToken, 0, {
        restore_token: { signature: 's', value: restoreToken },
      })
    );
    return `/org/freedesktop/portal/desktop/request/_/${handleToken}`;
  });
  bus.iface.script('NotifyPointerMotion', async () => undefined);
  bus.iface.script('NotifyPointerButton', async () => undefined);
  bus.iface.script('NotifyPointerAxis', async () => undefined);
}

// ---- Tests -----------------------------------------------------------------

describe('createPortalInput', () => {
  it('runs CreateSession → SelectDevices → Start on first input, skips on second', async () => {
    scriptHandshakeOK();
    const input = build();
    await input.move(200, 200);
    await input.move(300, 300);
    const sessionCalls = bus.log.filter((c) => c.iface === 'org.freedesktop.portal.RemoteDesktop' && c.member === 'CreateSession');
    const selectCalls = bus.log.filter((c) => c.member === 'SelectDevices');
    const startCalls = bus.log.filter((c) => c.member === 'Start');
    expect(sessionCalls).toHaveLength(1);
    expect(selectCalls).toHaveLength(1);
    expect(startCalls).toHaveLength(1);
    const seq = bus.log.map((c) => c.member).filter((m) =>
      ['CreateSession', 'SelectDevices', 'Start', 'NotifyPointerMotion'].includes(m)
    );
    expect(seq.slice(0, 3)).toEqual(['CreateSession', 'SelectDevices', 'Start']);
    cleanup();
  });

  it('passes restore_token from disk to SelectDevices when the file exists', async () => {
    writeFileSync(path.join(dir, 'remote-desktop-token'), 'persisted-token');
    scriptHandshakeOK();
    const input = build();
    await input.move(200, 200);
    const sel = bus.log.find((c) => c.member === 'SelectDevices')!;
    const opts = sel.args[1] as { restore_token?: { value: string } };
    expect(opts.restore_token?.value).toBe('persisted-token');
    cleanup();
  });

  it("persists the token Start returns (atomic: tmp + rename)", async () => {
    scriptHandshakeOK('fresh-token');
    const input = build();
    await input.move(200, 200);
    const tokenPath = path.join(dir, 'remote-desktop-token');
    expect(existsSync(tokenPath)).toBe(true);
    expect(readFileSync(tokenPath, 'utf8')).toBe('fresh-token');
    expect(existsSync(`${tokenPath}.tmp`)).toBe(false);
    cleanup();
  });

  it('click issues motion(dx, dy) → button(press) → button(release)', async () => {
    scriptHandshakeOK();
    const input = build();
    getCursor = () => ({ x: 100, y: 200 });
    await input.click(150, 250, 'left');
    const events = bus.log
      .filter((c) => c.member.startsWith('NotifyPointer'))
      .map((c) => ({ m: c.member, args: c.args }));
    expect(events).toHaveLength(3);
    expect(events[0]!.m).toBe('NotifyPointerMotion');
    const [, , dx, dy] = events[0]!.args as [unknown, unknown, number, number];
    expect(dx).toBe(50);
    expect(dy).toBe(50);
    expect(events[1]!.m).toBe('NotifyPointerButton');
    expect((events[1]!.args as unknown[])[2]).toBe(0x110); // BTN_LEFT
    expect((events[1]!.args as unknown[])[3]).toBe(1); // press
    expect(events[2]!.m).toBe('NotifyPointerButton');
    expect((events[2]!.args as unknown[])[3]).toBe(0); // release
    cleanup();
  });

  it('serializes concurrent click + move — no interleaving', async () => {
    scriptHandshakeOK();
    const input = build();
    const a = input.click(100, 100, 'left');
    const b = input.move(500, 500);
    await Promise.all([a, b]);
    const events = bus.log
      .filter((c) => c.member.startsWith('NotifyPointer'))
      .map((c) => c.member);
    // click emits motion + button + button; move emits one motion. Click ran
    // first, so its three events should precede the move's motion.
    expect(events).toEqual([
      'NotifyPointerMotion',
      'NotifyPointerButton',
      'NotifyPointerButton',
      'NotifyPointerMotion',
    ]);
    cleanup();
  });

  it('rejects when Start responds with non-zero code; no token written', async () => {
    bus.iface.script('CreateSession', async (args) => {
      const opts = args[0] as { handle_token: { value: string } };
      const handleToken = opts.handle_token.value;
      queueMicrotask(() =>
        bus.emitResponse(handleToken, 0, {
          session_handle: { signature: 'o', value: '/org/freedesktop/portal/desktop/session/_/s1' },
        })
      );
      return `/org/freedesktop/portal/desktop/request/_/${handleToken}`;
    });
    bus.iface.script('SelectDevices', async (args) => {
      const opts = args[1] as { handle_token: { value: string } };
      const handleToken = opts.handle_token.value;
      queueMicrotask(() => bus.emitResponse(handleToken, 0, {}));
      return `/org/freedesktop/portal/desktop/request/_/${handleToken}`;
    });
    bus.iface.script('Start', async (args) => {
      const opts = args[2] as { handle_token: { value: string } };
      const handleToken = opts.handle_token.value;
      queueMicrotask(() => bus.emitResponse(handleToken, 1, {})); // user denied
      return `/org/freedesktop/portal/desktop/request/_/${handleToken}`;
    });
    const input = build();
    await expect(input.move(200, 200)).rejects.toThrow(/portal/i);
    expect(existsSync(path.join(dir, 'remote-desktop-token'))).toBe(false);
    cleanup();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/main/input/portal.test.ts`
Expected: FAIL — all tests fail because the stub `createPortalInput` from Task 1 just rejects with `'portal input not yet implemented'`.

- [ ] **Step 3: Replace `portal.ts` with the real implementation**

Open `src/main/input/portal.ts` and replace the entire contents with:

```ts
import dbus, { type MessageBus } from 'dbus-next';
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
  configDir: string;
  bus?: MessageBus;
  getCursor?: () => { x: number; y: number };
}

const PORTAL_SERVICE = 'org.freedesktop.portal.Desktop';
const PORTAL_OBJECT = '/org/freedesktop/portal/desktop';
const REMOTE_DESKTOP_IFACE = 'org.freedesktop.portal.RemoteDesktop';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';

const BTN_CODE: Record<MouseButton, number> = {
  left: 0x110,
  right: 0x111,
  middle: 0x112,
};
const SCROLL_NOTCH = 10;
const DOUBLE_CLICK_DELAY_MS = 50;

interface RemoteDesktopIface {
  CreateSession(opts: Record<string, unknown>): Promise<string>;
  SelectDevices(session: string, opts: Record<string, unknown>): Promise<string>;
  Start(session: string, parentWindow: string, opts: Record<string, unknown>): Promise<string>;
  NotifyPointerMotion(session: string, opts: Record<string, unknown>, dx: number, dy: number): Promise<void>;
  NotifyPointerButton(session: string, opts: Record<string, unknown>, button: number, state: number): Promise<void>;
  NotifyPointerAxis(session: string, opts: Record<string, unknown>, dx: number, dy: number): Promise<void>;
}

interface RequestIface {
  on(signal: 'Response', handler: (code: number, results: Record<string, unknown>) => void): void;
  off(signal: 'Response', handler: (code: number, results: Record<string, unknown>) => void): void;
}

type VariantLike = { value: unknown };
function v(signature: string, value: unknown): VariantLike {
  // dbus-next's Variant. Use the library's Variant class when available;
  // otherwise this object-with-signature form is what the stubs read in tests.
  const Variant = (dbus as unknown as { Variant?: new (s: string, v: unknown) => VariantLike }).Variant;
  if (Variant) return new Variant(signature, value);
  return { value };
}

function randomToken(): string {
  return `t${randomBytes(8).toString('hex')}`;
}

export function createPortalInput(deps: PortalDeps): InputHandle {
  const tokenPath = path.join(deps.configDir, 'remote-desktop-token');
  const getCursor = deps.getCursor ?? (() => screen.getCursorScreenPoint());

  let busRef: MessageBus | null = deps.bus ?? null;
  let sessionPath: string | null = null;
  let handshakePromise: Promise<void> | null = null;
  let tail: Promise<void> = Promise.resolve();

  async function getBus(): Promise<MessageBus> {
    if (busRef) return busRef;
    busRef = dbus.sessionBus();
    return busRef;
  }

  async function getRemoteDesktop(): Promise<RemoteDesktopIface> {
    const bus = await getBus();
    const proxy = await bus.getProxyObject(PORTAL_SERVICE, PORTAL_OBJECT);
    return proxy.getInterface(REMOTE_DESKTOP_IFACE) as unknown as RemoteDesktopIface;
  }

  /**
   * Subscribe to the one-shot Response signal on a request object path.
   * Resolves with the results dict; rejects if the portal returns a non-zero
   * code (1 = user cancelled, 2 = other failure).
   */
  async function awaitResponse(requestPath: string): Promise<Record<string, unknown>> {
    const bus = await getBus();
    const proxy = await bus.getProxyObject(PORTAL_SERVICE, requestPath);
    const iface = proxy.getInterface(REQUEST_IFACE) as unknown as RequestIface;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const handler = (code: number, results: Record<string, unknown>) => {
        iface.off('Response', handler);
        if (code !== 0) {
          reject(new Error(`portal request failed (code ${code})`));
          return;
        }
        resolve(results);
      };
      iface.on('Response', handler);
    });
  }

  async function readTokenFile(): Promise<string | null> {
    try {
      return (await fsp.readFile(tokenPath, 'utf8')).trim() || null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writeTokenFile(token: string): Promise<void> {
    const tmp = `${tokenPath}.tmp`;
    await fsp.writeFile(tmp, token, 'utf8');
    await fsp.rename(tmp, tokenPath);
  }

  function variantString(v: unknown): string | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const val = (v as VariantLike).value;
    return typeof val === 'string' ? val : undefined;
  }

  async function handshake(): Promise<void> {
    const rd = await getRemoteDesktop();
    const sessionToken = randomToken();
    // CreateSession
    {
      const handleToken = randomToken();
      const reqPath = await rd.CreateSession({
        handle_token: v('s', handleToken),
        session_handle_token: v('s', sessionToken),
      });
      const results = await awaitResponse(reqPath);
      const sp = variantString(results.session_handle);
      if (!sp) throw new Error('portal CreateSession: missing session_handle');
      sessionPath = sp;
    }
    // SelectDevices
    {
      const handleToken = randomToken();
      const restore = await readTokenFile();
      const opts: Record<string, unknown> = {
        handle_token: v('s', handleToken),
        types: v('u', 2), // pointer
        persist_mode: v('u', 2), // persist permanently
      };
      if (restore) opts.restore_token = v('s', restore);
      const reqPath = await rd.SelectDevices(sessionPath!, opts);
      await awaitResponse(reqPath);
    }
    // Start
    {
      const handleToken = randomToken();
      const reqPath = await rd.Start(sessionPath!, '', {
        handle_token: v('s', handleToken),
      });
      const results = await awaitResponse(reqPath);
      const newToken = variantString(results.restore_token);
      if (newToken) {
        try {
          await writeTokenFile(newToken);
        } catch (err) {
          logger.warn(`portal: failed to persist restore_token: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  async function ensureSession(): Promise<void> {
    if (sessionPath) return;
    if (!handshakePromise) {
      handshakePromise = handshake().catch((err) => {
        // Reset so the next input call retries from scratch.
        handshakePromise = null;
        sessionPath = null;
        throw err;
      });
    }
    await handshakePromise;
  }

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn);
    // Keep the chain alive even if a call rejects.
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function rawMove(x: number, y: number): Promise<void> {
    const rd = await getRemoteDesktop();
    const cur = getCursor();
    const dx = Math.round(x - cur.x);
    const dy = Math.round(y - cur.y);
    if (dx === 0 && dy === 0) return;
    await rd.NotifyPointerMotion(sessionPath!, {}, dx, dy);
  }

  async function rawButton(button: MouseButton, state: 0 | 1): Promise<void> {
    const rd = await getRemoteDesktop();
    await rd.NotifyPointerButton(sessionPath!, {}, BTN_CODE[button], state);
  }

  async function rawAxis(dx: number, dy: number): Promise<void> {
    const rd = await getRemoteDesktop();
    await rd.NotifyPointerAxis(sessionPath!, { finish: v('b', true) }, dx * SCROLL_NOTCH, dy * SCROLL_NOTCH);
  }

  return {
    move(x, y) {
      return serialize(async () => {
        await ensureSession();
        await rawMove(x, y);
      });
    },
    click(x, y, button) {
      return serialize(async () => {
        await ensureSession();
        await rawMove(x, y);
        await rawButton(button, 1);
        await rawButton(button, 0);
      });
    },
    doubleClick(x, y, button) {
      return serialize(async () => {
        await ensureSession();
        await rawMove(x, y);
        await rawButton(button, 1);
        await rawButton(button, 0);
        await new Promise<void>((r) => setTimeout(r, DOUBLE_CLICK_DELAY_MS));
        await rawButton(button, 1);
        await rawButton(button, 0);
      });
    },
    drag(x1, y1, x2, y2, button) {
      return serialize(async () => {
        await ensureSession();
        await rawMove(x1, y1);
        await rawButton(button, 1);
        await rawMove(x2, y2);
        await rawButton(button, 0);
      });
    },
    scroll(dx, dy, x, y) {
      return serialize(async () => {
        await ensureSession();
        if (x !== undefined && y !== undefined) await rawMove(x, y);
        await rawAxis(dx, dy);
      });
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/main/input/portal.test.ts`
Expected: PASS all 6 tests.

If any test fails because the stub doesn't match the real `getProxyObject` path that dbus-next's `Variant` checks for, the most likely cause is the `Variant` class detection. The fallback `{ value }` form is what the stubs expect; the real `dbus` library exposes `Variant` via the default export. Adjust the `v()` helper if needed — the contract is "produces something whose `.value` matches what the stub reads."

- [ ] **Step 5: Commit**

```bash
git add src/main/input/portal.ts src/main/input/portal.test.ts
git commit -m "$(cat <<'EOF'
feat(input): portal handshake + event dispatch via dbus-next

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire portal into the Linux adapter

**Files:**
- Modify: `src/main/platform/linux.ts`

- [ ] **Step 1: Add lazy `portalInput` accessor**

Read `src/main/platform/linux.ts`. Near the top of the class (next to the other private fields), add:

```ts
private portalInput: import('../input/portal').InputHandle | null = null;

private getPortalInput(): import('../input/portal').InputHandle {
  if (!this.portalInput) {
    // Lazy import to avoid pulling dbus-next into the bundle until first use.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createPortalInput } = require('../input/portal') as typeof import('../input/portal');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ottoConfigDir } = require('../logger') as typeof import('../logger');
    this.portalInput = createPortalInput({ configDir: ottoConfigDir });
  }
  return this.portalInput;
}
```

- [ ] **Step 2: Replace the five mouse method bodies**

In the `input: PlatformInput = { ... }` block, replace:

- `move`:
  ```ts
  move: async (x, y) => {
    await this.getPortalInput().move(x, y);
  },
  ```
- `click`:
  ```ts
  click: async (x, y, button) => {
    await this.getPortalInput().click(x, y, button);
  },
  ```
- `doubleClick`:
  ```ts
  doubleClick: async (x, y, button) => {
    await this.getPortalInput().doubleClick(x, y, button);
  },
  ```
- `drag`:
  ```ts
  drag: async (x1, y1, x2, y2, button) => {
    await this.getPortalInput().drag(x1, y1, x2, y2, button);
  },
  ```
- `scroll`:
  ```ts
  scroll: async (dx, dy, x, y) => {
    await this.getPortalInput().scroll(dx, dy, x, y);
  },
  ```

Each replacement removes the `await this.ensureXdotool()` call and the `runXdotool(...)` invocations from that specific method. `type`, `key`, and `cursorPosition` are untouched.

- [ ] **Step 3: Typecheck + run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS — the portal tests use the injected `bus` stub; the platform adapter's other tests don't exercise mouse methods directly. If any test asserted on `xdotool` mouse calls (unlikely — grep `src/main/platform/platform.test.ts` for `mousemove`/`click` first), update that assertion.

- [ ] **Step 4: Commit**

```bash
git add src/main/platform/linux.ts
git commit -m "$(cat <<'EOF'
feat(platform): mouse methods delegate to portal input

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: IPC channels for status + revoke

**Files:**
- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/main/ipc/handlers.ts`

- [ ] **Step 1: Add channels to the contract**

In `src/shared/ipc-contract.ts`, extend `IpcRequest` (insert near the other settings/* channels):

```ts
  | { channel: 'remoteDesktop.status'; args: void; result: { granted: boolean } }
  | { channel: 'remoteDesktop.revoke'; args: void; result: void }
```

- [ ] **Step 2: Add handlers**

In `src/main/ipc/handlers.ts`, add handlers inside `registerIpcHandlers` alongside the others:

```ts
ipcMain.handle('remoteDesktop.status', async (): Promise<{ granted: boolean }> => {
  const tokenPath = path.join(deps.configDir, 'remote-desktop-token');
  try {
    await fsp.access(tokenPath);
    return { granted: true };
  } catch {
    return { granted: false };
  }
});

ipcMain.handle('remoteDesktop.revoke', async (): Promise<void> => {
  const tokenPath = path.join(deps.configDir, 'remote-desktop-token');
  try {
    await fsp.unlink(tokenPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
});
```

`path` and `fsp` are already imported in `handlers.ts` from the Memory IPC work. `deps.configDir` is already a constructor param. No new wiring needed.

Note: this only deletes the token file. The next mouse-input call re-triggers the portal handshake (and the user-facing dialog). The in-process `portalInput`'s cached `sessionPath` is *not* invalidated — meaning if Otto already has a live session, mouse input keeps working until app restart. Acceptable for v1; a follow-up could invalidate the cached session via an IPC-fired event.

- [ ] **Step 3: Typecheck + test**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-contract.ts src/main/ipc/handlers.ts
git commit -m "$(cat <<'EOF'
feat(ipc): remoteDesktop.status + remoteDesktop.revoke

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Remote desktop settings section

**Files:**
- Create: `src/renderer/components/settings/RemoteDesktopSection.tsx`
- Create: `src/renderer/components/settings/RemoteDesktopSection.test.tsx`
- Modify: `src/renderer/components/settings/SettingsNav.ts`
- Modify: `src/renderer/SettingsApp.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/components/settings/RemoteDesktopSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RemoteDesktopSection } from './RemoteDesktopSection';

const invokeMock = vi.fn();

beforeEach(() => {
  invokeMock.mockReset();
  (globalThis as unknown as { window: Window & { otto?: unknown } }).window.otto = {
    invoke: invokeMock,
  };
});

describe('RemoteDesktopSection', () => {
  it('renders Granted when status reports granted', async () => {
    invokeMock.mockResolvedValueOnce({ granted: true });
    render(<RemoteDesktopSection />);
    await waitFor(() => expect(screen.getByText(/granted/i)).toBeTruthy());
  });

  it('renders Not yet requested when status reports not granted', async () => {
    invokeMock.mockResolvedValueOnce({ granted: false });
    render(<RemoteDesktopSection />);
    await waitFor(() => expect(screen.getByText(/not yet requested/i)).toBeTruthy());
  });

  it('clicking Revoke calls remoteDesktop.revoke and refreshes status', async () => {
    invokeMock
      .mockResolvedValueOnce({ granted: true }) // initial status
      .mockResolvedValueOnce(undefined) // revoke
      .mockResolvedValueOnce({ granted: false }); // refreshed status
    render(<RemoteDesktopSection />);
    await waitFor(() => expect(screen.getByText(/granted/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /revoke access/i }));
    // The first click reveals an inline confirmation. Click again to confirm.
    fireEvent.click(screen.getByRole('button', { name: /^yes$/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('remoteDesktop.revoke', undefined)
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/components/settings/RemoteDesktopSection.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `src/renderer/components/settings/RemoteDesktopSection.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { ipc } from '../../ipc';
import { SubsectionPage } from './SubsectionPage';

export function RemoteDesktopSection() {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [armed, setArmed] = useState(false);

  async function refresh() {
    const out = await ipc.invoke('remoteDesktop.status', undefined);
    setGranted(out.granted);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function revoke() {
    await ipc.invoke('remoteDesktop.revoke', undefined);
    setArmed(false);
    await refresh();
  }

  return (
    <SubsectionPage
      title="Remote desktop"
      description="Otto controls the mouse via KDE's desktop portal. The first click triggers a permission dialog; access persists across launches until revoked."
    >
      <div className="text-sm text-text py-2">
        {granted === null
          ? 'Checking…'
          : granted
            ? 'Granted — Otto can control the mouse.'
            : 'Not yet requested — the dialog will appear the first time Otto needs to click.'}
      </div>
      {granted && (
        <div className="pt-2">
          {armed ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted">Revoke remote desktop access?</span>
              <button
                type="button"
                onClick={revoke}
                className="px-2 py-0.5 rounded bg-danger text-white hover:bg-danger/90"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setArmed(false)}
                className="text-muted hover:text-text"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setArmed(true)}
              className="text-xs text-danger hover:underline"
            >
              Revoke access…
            </button>
          )}
        </div>
      )}
    </SubsectionPage>
  );
}
```

- [ ] **Step 4: Add nav entry**

In `src/renderer/components/settings/SettingsNav.ts`, find the `general` tab's `subs` array. Insert `{ id: 'remoteDesktop', label: 'Remote desktop' }` between `shortcut` and `startup`:

```ts
subs: [
  { id: 'model', label: 'Model' },
  { id: 'window', label: 'Window' },
  { id: 'shortcut', label: 'Shortcut' },
  { id: 'remoteDesktop', label: 'Remote desktop' },
  { id: 'startup', label: 'Startup' },
],
```

- [ ] **Step 5: Wire dispatcher in `SettingsApp.tsx`**

In `src/renderer/SettingsApp.tsx`, add the import:

```tsx
import { RemoteDesktopSection } from './components/settings/RemoteDesktopSection';
```

In `renderSubsection`, inside the `if (activeTab === 'general')` branch, add (before the `startup` branch):

```tsx
if (activeSub === 'remoteDesktop') return <RemoteDesktopSection />;
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm run typecheck && npm test -- src/renderer/components/settings/RemoteDesktopSection.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/settings/RemoteDesktopSection.tsx src/renderer/components/settings/RemoteDesktopSection.test.tsx src/renderer/components/settings/SettingsNav.ts src/renderer/SettingsApp.tsx
git commit -m "$(cat <<'EOF'
feat(settings): Remote desktop status + revoke section

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: System prompt cleanup + manual smoke

**Files:**
- Modify: `src/main/agent/sdk-client.ts`

- [ ] **Step 1: Remove the obsolete cursor-warp tip**

In `src/main/agent/sdk-client.ts`'s `SYSTEM_PROMPT` array, find this line:

```ts
'   Cursor-warp tip: on Wayland the cursor cannot be teleported reliably; if a click needs to land precisely, use `kdotool windowactivate` to focus the right window first, then use keyboard navigation (`key("Tab")`, `key("Return")`) instead of clicking when possible.',
```

Delete the entire line (the leading-whitespace string IS the whole element of the array — remove the whole quoted entry plus its trailing comma).

The "CRITICAL focus discipline" lines that follow remain — they're about post-approval focus, still relevant.

- [ ] **Step 2: Typecheck + run full suite**

Run: `npm run typecheck && npm test && npm run lint`
Expected: PASS. Lint may still show the pre-existing `BUTTON_CODE` / `BUTTON_LOW` warnings in `linux.ts` — unrelated.

- [ ] **Step 3: Manual smoke test on the real KDE Wayland 3440×1440 setup**

Run: `npm run dev`

1. Open a native Wayland app where xdotool would have failed — **Dolphin** is reliable. Place it where you can identify a click target.
2. Ask Otto to take a screenshot of Dolphin and click on a specific item (e.g., a folder).
3. On the first click attempt, KDE shows the "Allow Otto to control your mouse?" dialog. Approve.
4. Verify the click lands on the right item — selection should change in Dolphin.
5. Restart Otto (quit + relaunch via tray).
6. Ask Otto to click another item. **No dialog should appear** this time (token reuse).
7. Open Settings → General → Remote desktop. Confirm status reads "Granted". Click Revoke → Yes.
8. Ask Otto to click again. Dialog should reappear.

If clicks land off-target, the most likely cause is the `dx/dy` rounding or the cursor-position read happening at the wrong time. Add a `logger.debug` line in `rawMove` to print `target / cur / dx / dy` and compare to expectation.

- [ ] **Step 4: Commit**

```bash
git add src/main/agent/sdk-client.ts
git commit -m "$(cat <<'EOF'
chore(agent): drop obsolete Wayland cursor-warp tip from system prompt

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes (already applied above)

- **Spec coverage:**
  - Spec §1 (architecture, new module + dep) → Tasks 1 + 2.
  - Spec §2 (handshake + dispatch + token persistence + concurrency + error handling) → Task 2 (all six tests cover it).
  - Spec §3 (linux adapter wiring) → Task 3.
  - Spec §3 (settings UI + IPC) → Tasks 4 + 5.
  - Spec §3 (system prompt cleanup) → Task 6.
  - Spec §4 (testing) → Task 2 (portal tests), Task 5 (renderer tests), Task 6 (manual smoke).
- **Placeholder scan:** every code block is complete.
- **Type consistency:** `InputHandle` shape (`move/click/doubleClick/drag/scroll`) is identical between Tasks 1, 2, and 3. `MouseButton` union (`'left' | 'right' | 'middle'`) matches the existing `PlatformInput` type from `src/main/platform/index.ts`. `BTN_CODE` map values (`0x110/0x111/0x112`) are the standard Linux input-event codes. The `getCursor` injection point in `PortalDeps` matches the tests' usage in Task 2.
- **Task 3 lazy-load** uses CJS `require` for `portal.ts` and `logger.ts` because the existing linux.ts class needs synchronous access from inside the `input: PlatformInput = { ... }` initializer block. This matches a few existing CJS-style requires elsewhere in the codebase; if eslint flags it, the inline disable comment is appropriate.
