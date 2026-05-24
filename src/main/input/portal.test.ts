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
let getCursor: () => { x: number; y: number };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-portal-'));
  bus = new StubBus();
  getCursor = () => ({ x: 100, y: 100 });
});

function build(): InputHandle {
  return createPortalInput({
    configDir: dir,
    bus: bus as unknown as import('dbus-next').MessageBus,
    getCursor: () => getCursor(),
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

  it('click issues a single relative motion then button press/release for small deltas', async () => {
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

  it('chunks long motion into MAX_DELTA_PX (150px) steps to avoid pointer-accel overshoot', async () => {
    scriptHandshakeOK();
    const input = build();
    getCursor = () => ({ x: 0, y: 0 });
    await input.move(500, 0);
    const deltas = bus.log
      .filter((c) => c.member === 'NotifyPointerMotion')
      .map((c) => {
        const [, , dx, dy] = c.args as [unknown, unknown, number, number];
        return { dx, dy };
      });
    expect(deltas).toEqual([
      { dx: 150, dy: 0 },
      { dx: 150, dy: 0 },
      { dx: 150, dy: 0 },
      { dx: 50, dy: 0 },
    ]);
    cleanup();
  });

  it('skips the motion call entirely when the target equals the tracked cursor', async () => {
    scriptHandshakeOK();
    const input = build();
    getCursor = () => ({ x: 100, y: 100 });
    await input.move(100, 100);
    const motions = bus.log.filter((c) => c.member === 'NotifyPointerMotion');
    expect(motions).toHaveLength(0);
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
    // click(100,100) from cursor (100,100) is a no-op motion (delta 0,0);
    // then button press/release. Then move(500,500) from lastSentCursor
    // (100,100) — delta (400,400) — gets chunked into 3 steps under the
    // 150px cap: (150,150), (150,150), (100,100).
    expect(events).toEqual([
      'NotifyPointerButton',
      'NotifyPointerButton',
      'NotifyPointerMotion',
      'NotifyPointerMotion',
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
