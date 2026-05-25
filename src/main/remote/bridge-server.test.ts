import { describe, it, expect, afterEach } from 'vitest';
import { BridgeServer } from './bridge-server';
import { SessionBus } from './session-bus';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db';
import { PairingStore } from './pairing-store';
import WebSocket from 'ws';

let server: BridgeServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  if (server) await server.stop();
  server = null;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function makeStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'otto-bridge-'));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, 'otto.db'));
  return new PairingStore(db, () => 1000);
}

describe('BridgeServer HTTP', () => {
  it('refuses to start when no tailnet IP is provided', async () => {
    server = new BridgeServer({ tailnetIp: null, pairing: makeStore(), bus: new SessionBus(), pwaDir: null });
    await expect(server.start()).rejects.toThrow(/tailnet/i);
  });

  it('binds to the provided IP and serves a 404 for unknown paths', async () => {
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null });
    const { port } = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });
});

describe('BridgeServer /pair', () => {
  it('mints a code, accepts /pair with that code, returns a token', async () => {
    const pairing = makeStore();
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing, bus: new SessionBus(), pwaDir: null });
    const { port } = await server.start();
    const code = server.mintPairingCode();
    const res = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceLabel: 'iPhone' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; deviceId: string };
    expect(body.token).toMatch(/.{40,}/);
    expect(body.deviceId).toBeTruthy();
    expect(pairing.list()).toHaveLength(1);
  });

  it('rejects unknown pairing codes with 401', async () => {
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null });
    const { port } = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'bogus', deviceLabel: 'iPhone' }),
    });
    expect(res.status).toBe(401);
  });

  it('a pairing code is single-use', async () => {
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null });
    const { port } = await server.start();
    const code = server.mintPairingCode();
    const ok = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceLabel: 'A' }) });
    expect(ok.status).toBe(200);
    const dup = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceLabel: 'B' }) });
    expect(dup.status).toBe(401);
  });

  it('rate-limits /pair to 10 requests per minute per IP', async () => {
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null });
    const { port } = await server.start();
    for (let i = 0; i < 10; i++) {
      await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'bogus', deviceLabel: 'x' }) });
    }
    const blocked = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'bogus', deviceLabel: 'x' }) });
    expect(blocked.status).toBe(429);
  });
});

describe('BridgeServer WS auth', () => {
  it('WS closes with auth_failed when first frame is not a valid auth', async () => {
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null });
    const { port } = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'prompt', sessionId: 's1', text: 'hi' })));
    const ev = await closed;
    expect(ev.reason).toMatch(/auth/i);
  });

  it('WS accepts a valid token and replies auth_ok', async () => {
    const pairing = makeStore();
    const bus = new SessionBus();
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null });
    const { port } = await server.start();
    const { token } = await pairing.issue('iPhone');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const ok = await new Promise<unknown>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token })));
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
      ws.on('error', reject);
    });
    ws.close();
    expect(ok).toMatchObject({ type: 'auth_ok' });
  });

  it('forwards SessionBus events for the active session to the WS', async () => {
    const pairing = makeStore();
    const bus = new SessionBus();
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null, activeSessionId: () => 's1' });
    const { port } = await server.start();
    const { token } = await pairing.issue('iPhone');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: unknown[] = [];
    await new Promise<void>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token })));
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString());
        messages.push(m);
        if (m.type === 'auth_ok') {
          bus.publish('s1', { type: 'event', kind: 'text-delta', text: 'hello' });
          setTimeout(resolve, 50);
        }
      });
    });
    ws.close();
    expect(messages).toContainEqual(expect.objectContaining({ type: 'event', kind: 'text-delta', text: 'hello' }));
  });
});
