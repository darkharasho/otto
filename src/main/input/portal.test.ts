import { describe, it, expect, beforeEach } from 'vitest';
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
      return { getInterface: (_name: string) => this.iface as unknown };
    }
    let req = this.requestIfaces.get(objectPath);
    if (!req) {
      req = new StubInterface('org.freedesktop.portal.Request', this.log);
      this.requestIfaces.set(objectPath, req);
    }
    return { getInterface: (_name: string) => req as unknown };
  }

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

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-portal-'));
  bus = new StubBus();
});

function build(): InputHandle {
  return createPortalInput({
    configDir: dir,
    bus: bus as unknown as import('dbus-next').MessageBus,
  });
}

function cleanup() {
  rmSync(dir, { recursive: true, force: true });
}

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
    const sessionCalls = bus.log.filter((c) => c.member === 'CreateSession');
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

  it('persists the token Start returns (atomic: tmp + rename)', async () => {
    scriptHandshakeOK('fresh-token');
    const input = build();
    await input.move(200, 200);
    const tokenPath = path.join(dir, 'remote-desktop-token');
    expect(existsSync(tokenPath)).toBe(true);
    expect(readFileSync(tokenPath, 'utf8')).toBe('fresh-token');
    expect(existsSync(`${tokenPath}.tmp`)).toBe(false);
    cleanup();
  });

  it('click homes to the corner, travels to the target, then presses/releases', async () => {
    scriptHandshakeOK();
    const input = build();
    await input.click(150, 250, 'left');
    const events = bus.log
      .filter((c) => c.member.startsWith('NotifyPointer'))
      .map((c) => ({ m: c.member, args: c.args as [unknown, unknown, number, number] }));
    const motions = events.filter((e) => e.m === 'NotifyPointerMotion');
    // First motion is the corner-homing slam (one large negative delta).
    expect(motions[0]!.args[2]).toBeLessThan(-1000);
    expect(motions[0]!.args[3]).toBeLessThan(-1000);
    // The rest travels from origin (0,0) and sums to the target.
    const travel = motions.slice(1);
    expect(travel.reduce((s, m) => s + m.args[2], 0)).toBe(150);
    expect(travel.reduce((s, m) => s + m.args[3], 0)).toBe(250);
    // Then a left-button press and release, in that order.
    const buttons = events.filter((e) => e.m === 'NotifyPointerButton');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.args[2]).toBe(0x110); // BTN_LEFT
    expect(buttons[0]!.args[3]).toBe(1); // press
    expect(buttons[1]!.args[3]).toBe(0); // release
    cleanup();
  });

  it('homes to the corner before a standalone move, ignoring any prior/stale position', async () => {
    // Regression: on Wayland we cannot read the cursor reliably (Electron's
    // getCursorScreenPoint freezes once the pointer leaves an Electron
    // surface — e.g. while over a Wine/XWayland window). The old code trusted
    // that stale reading as the relative-motion origin, so clicks landed at
    // (real_cursor + delta-from-phantom-origin) and missed entirely. Now every
    // standalone move first slams the cursor into the top-left corner (which
    // KWin clamps to the virtual-desktop origin 0,0), giving a known origin.
    scriptHandshakeOK();
    const input = build();
    // Place the cursor far away, then move twice. Neither move may trust the
    // previous landing spot as a free origin — each re-homes.
    await input.move(800, 600);
    const firstMotions = bus.log
      .filter((c) => c.member === 'NotifyPointerMotion')
      .map((c) => c.args as [unknown, unknown, number, number]);
    // First event of the move is the corner-homing slam: one large negative
    // delta, deliberately unchunked (the oversize is what forces the clamp).
    expect(firstMotions[0]![2]).toBeLessThan(-1000);
    expect(firstMotions[0]![3]).toBeLessThan(-1000);
    // Travel that follows sums to the target from origin (0,0).
    const travel = firstMotions.slice(1);
    const sumX = travel.reduce((s, m) => s + m[2], 0);
    const sumY = travel.reduce((s, m) => s + m[3], 0);
    expect(sumX).toBe(800);
    expect(sumY).toBe(600);
    cleanup();
  });

  it('chunks long travel into MAX_DELTA_PX (150px) steps to avoid pointer-accel overshoot', async () => {
    scriptHandshakeOK();
    const input = build();
    await input.move(500, 0);
    const deltas = bus.log
      .filter((c) => c.member === 'NotifyPointerMotion')
      .map((c) => {
        const [, , dx, dy] = c.args as [unknown, unknown, number, number];
        return { dx, dy };
      });
    // First delta is the corner-homing slam; the rest is the chunked travel.
    expect(deltas[0]!.dx).toBeLessThan(-1000);
    expect(deltas.slice(1)).toEqual([
      { dx: 150, dy: 0 },
      { dx: 150, dy: 0 },
      { dx: 150, dy: 0 },
      { dx: 50, dy: 0 },
    ]);
    cleanup();
  });

  it('drag homes once for the press, then travels from the press point (no re-home)', async () => {
    scriptHandshakeOK();
    const input = build();
    await input.drag(100, 100, 400, 100, 'left');
    const motions = bus.log
      .filter((c) => c.member === 'NotifyPointerMotion')
      .map((c) => c.args as [unknown, unknown, number, number]);
    // Exactly one corner-homing slam — for the first leg only.
    const homes = motions.filter((m) => m[2] <= -1000 || m[3] <= -1000);
    expect(homes).toHaveLength(1);
    // The second leg travels the (300,0) delta from the press point, not via
    // the corner: its motion chunks are all positive and sum to the delta.
    const firstButtonIdx = bus.log.findIndex((c) => c.member === 'NotifyPointerButton');
    const leg2 = bus.log
      .slice(firstButtonIdx)
      .filter((c) => c.member === 'NotifyPointerMotion')
      .map((c) => c.args as [unknown, unknown, number, number]);
    expect(leg2.every((m) => m[2] >= 0)).toBe(true);
    expect(leg2.reduce((s, m) => s + m[2], 0)).toBe(300);
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
    // click(100,100): home slam + one travel chunk (0,0)→(100,100), then
    // press/release. Then move(500,500): home slam + four travel chunks
    // (150,150)x3 + (50,50). All of the click's events precede all of the
    // move's — proving the two gestures never interleave.
    expect(events).toEqual([
      'NotifyPointerMotion', // click: home
      'NotifyPointerMotion', // click: travel to (100,100)
      'NotifyPointerButton', // press
      'NotifyPointerButton', // release
      'NotifyPointerMotion', // move: home
      'NotifyPointerMotion', // move: travel chunk 1
      'NotifyPointerMotion', // move: travel chunk 2
      'NotifyPointerMotion', // move: travel chunk 3
      'NotifyPointerMotion', // move: travel chunk 4
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
