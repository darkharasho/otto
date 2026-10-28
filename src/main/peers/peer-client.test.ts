import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { openDatabase } from '../db/db';
import { PairingStore } from '../remote/pairing-store';
import { SessionBus } from '../remote/session-bus';
import { BridgeServer } from '../remote/bridge-server';
import { PeerClient, pairWithPeer, parsePairingUrl } from './peer-client';
import type { RemoteEvent } from '@shared/delegation';

let dirs: string[] = [];
let servers: BridgeServer[] = [];
let clients: PeerClient[] = [];

beforeEach(() => { dirs = []; servers = []; clients = []; });
afterEach(async () => {
  for (const c of clients) c.close();
  for (const s of servers) await stopServer(s);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// BridgeServer.stop() waits on open sockets; drop them so stop() resolves like a real host going away.
async function stopServer(s: BridgeServer): Promise<void> {
  const wss = (s as unknown as { wss: { clients: Set<{ terminate(): void }> } | null }).wss;
  wss?.clients.forEach((c) => c.terminate());
  await s.stop();
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

interface Hooks {
  busy?: boolean;
  approvals: Array<{ id: string; choice: string }>;
  sudos: Array<{ id: string; pw: string | null }>;
  interrupts: Array<string | undefined>;
  delegations: Array<{ text: string; sessionId?: string; interruptFirst: boolean }>;
  onStart?: (sessionId: string) => void;
  failWith?: string;
}

function setup(port = 0) {
  const dir = mkdtempSync(path.join(tmpdir(), 'otto-peer-'));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, 'otto.db'));
  const pairing = new PairingStore(db, () => 1000);
  const bus = new SessionBus();
  const hooks: Hooks = { approvals: [], sudos: [], interrupts: [], delegations: [] };
  const makeServer = (p = port) => {
    const s = new BridgeServer({
      tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null, screenshotSecret: 'x',
      loadScreenshot: async () => null, activeSessionId: () => 'active-1', plainHttp: true, port: p,
      isBusy: () => !!hooks.busy,
      resolveApproval: (id, choice) => { hooks.approvals.push({ id, choice }); return true; },
      resolveSudo: (id, pw) => { hooks.sudos.push({ id, pw }); return true; },
      interruptTurn: (sid) => { hooks.interrupts.push(sid); },
      loadMessages: async () => [{ id: 'm1' }] as never,
      startDelegation: async (a) => {
        hooks.delegations.push(a);
        if (hooks.failWith) throw new Error(hooks.failWith);
        const sessionId = a.sessionId ?? 'sess-1';
        hooks.onStart?.(sessionId);
        return { sessionId };
      },
    });
    servers.push(s);
    return s;
  };
  return { pairing, bus, hooks, makeServer };
}

async function pairedClient(s: BridgeServer, port: number, opts: Partial<ConstructorParameters<typeof PeerClient>[0]> = {}) {
  const code = s.mintPairingCode();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { token, deviceId } = await pairWithPeer(baseUrl, code, 'Otto on test');
  const client = new PeerClient({ baseUrl, token, ...opts });
  clients.push(client);
  return { client, token, deviceId, baseUrl };
}

describe('parsePairingUrl', () => {
  it('parses a pairing link and rejects others', () => {
    expect(parsePairingUrl('http://100.1.2.3:17829/?code=abc')).toEqual({ baseUrl: 'http://100.1.2.3:17829', code: 'abc' });
    expect(() => parsePairingUrl('nope')).toThrow('Not an Otto pairing link');
    expect(() => parsePairingUrl('http://x:1/')).toThrow('Not an Otto pairing link');
    expect(() => parsePairingUrl('ftp://x:1/?code=a')).toThrow('Not an Otto pairing link');
  });
});

describe('PeerClient', () => {
  it('pairs with a minted code and connects', async () => {
    const { makeServer } = setup();
    const s = makeServer();
    const { port } = await s.start();
    const { client } = await pairedClient(s, port);
    await client.connect();
    const states: string[] = [];
    client.onConnectionChange((st) => states.push(st));
    expect(states).toEqual([]);
  });

  it('connect rejects unreachable within the timeout', async () => {
    const port = await freePort();
    const client = new PeerClient({ baseUrl: `http://127.0.0.1:${port}`, token: 't', connectTimeoutMs: 300 });
    clients.push(client);
    await expect(client.connect()).rejects.toThrow('unreachable');
  });

  it('connect rejects unreachable when the host never answers', async () => {
    const sockets: net.Socket[] = [];
    const silent = net.createServer((c) => { sockets.push(c); });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const port = (silent.address() as net.AddressInfo).port;
    const client = new PeerClient({ baseUrl: `http://127.0.0.1:${port}`, token: 't', connectTimeoutMs: 300 });
    clients.push(client);
    try { await expect(client.connect()).rejects.toThrow('unreachable'); } finally { sockets.forEach((c) => c.destroy()); silent.close(); }
  });

  it('connect rejects unauthorized for a revoked token', async () => {
    const { makeServer, pairing } = setup();
    const s = makeServer();
    const { port } = await s.start();
    const { client, deviceId } = await pairedClient(s, port);
    pairing.revoke(deviceId);
    await expect(client.connect()).rejects.toThrow('unauthorized');
  });

  it('delegate returns started and streams that session\'s events', async () => {
    const { makeServer, bus, hooks } = setup();
    hooks.onStart = (sid) => {
      setTimeout(() => {
        bus.publish(sid, { type: 'event', kind: 'text-delta', text: 'hi' });
        bus.publish('other', { type: 'event', kind: 'text-delta', text: 'nope' });
        bus.publish(sid, { type: 'event', kind: 'done' });
      }, 20);
    };
    const s = makeServer();
    const { port } = await s.start();
    const { client } = await pairedClient(s, port);
    await client.connect();
    const r = await client.delegate({ text: 'do it' });
    expect(r).toEqual({ kind: 'started', sessionId: 'sess-1' });
    const got: RemoteEvent[] = [];
    client.onEvent('sess-1', (e) => got.push(e));
    await waitFor(() => got.some((e) => e.kind === 'done'));
    expect(got.map((e) => e.kind)).toEqual(['text-delta', 'done']);
    expect(hooks.delegations[0]).toEqual({ text: 'do it', sessionId: undefined, interruptFirst: false });
  });

  it('delegate returns busy', async () => {
    const { makeServer, hooks } = setup();
    hooks.busy = true;
    const s = makeServer();
    const { port } = await s.start();
    const { client } = await pairedClient(s, port);
    await client.connect();
    expect(await client.delegate({ text: 'x' })).toEqual({ kind: 'busy', activeSessionId: 'active-1' });
    const r = await client.delegate({ text: 'x', ifBusy: 'interrupt' });
    expect(r.kind).toBe('started');
    expect(hooks.delegations[0]!.interruptFirst).toBe(true);
  });

  it('delegate_err rejects with the message', async () => {
    const { makeServer, hooks } = setup();
    hooks.failWith = 'boom';
    const s = makeServer();
    const { port } = await s.start();
    const { client } = await pairedClient(s, port);
    await client.connect();
    await expect(client.delegate({ text: 'x' })).rejects.toThrow('boom');
  });

  it('decide/sudo/interrupt send the right frames', async () => {
    const { makeServer, hooks } = setup();
    const s = makeServer();
    const { port } = await s.start();
    const { client } = await pairedClient(s, port);
    await client.connect();
    client.decide('d1', 'approve-session');
    client.sudo('p1', 'pw');
    client.sudo('p2', null);
    client.interrupt('sess-9');
    await waitFor(() => hooks.interrupts.length === 1 && hooks.sudos.length === 2);
    expect(hooks.approvals).toEqual([{ id: 'd1', choice: 'approve-session' }]);
    expect(hooks.sudos).toEqual([{ id: 'p1', pw: 'pw' }, { id: 'p2', pw: null }]);
    expect(hooks.interrupts).toEqual(['sess-9']);
  });

  it('reconnects and backfills from history without duplicates', async () => {
    const port = await freePort();
    const { makeServer, bus } = setup(port);
    let s = makeServer();
    await s.start();
    const { client } = await pairedClient(s, port, { reconnectWindowMs: 5000 });
    await client.connect();
    await client.delegate({ text: 'go' });
    const got: RemoteEvent[] = [];
    client.onEvent('sess-1', (e) => got.push(e));
    const states: string[] = [];
    client.onConnectionChange((st) => states.push(st));

    bus.publish('sess-1', { type: 'event', kind: 'text-delta', text: 'a' });
    bus.publish('sess-1', { type: 'event', kind: 'text-delta', text: 'b' });
    await waitFor(() => got.length === 2);

    await stopServer(s);
    await waitFor(() => states.includes('reconnecting'));
    bus.publish('sess-1', { type: 'event', kind: 'text-delta', text: 'c' });
    bus.publish('sess-1', { type: 'event', kind: 'done' });
    s = makeServer();
    await s.start();
    await waitFor(() => states.includes('connected'));
    await waitFor(() => got.length >= 4);
    bus.publish('sess-1', { type: 'event', kind: 'text-delta', text: 'd' });
    await waitFor(() => got.length >= 5);
    expect(got.map((e) => e.text ?? e.kind)).toEqual(['a', 'b', 'c', 'done', 'd']);
  });

  it('emits lost after the reconnect window elapses', async () => {
    const { makeServer } = setup();
    const s = makeServer();
    const { port } = await s.start();
    const { client } = await pairedClient(s, port, { reconnectWindowMs: 600, connectTimeoutMs: 200 });
    await client.connect();
    const states: string[] = [];
    client.onConnectionChange((st) => states.push(st));
    await stopServer(s);
    await waitFor(() => states.includes('lost'), 4000);
    expect(states[0]).toBe('reconnecting');
  });
});
