import { describe, it, expect, afterEach } from 'vitest';
import { BridgeServer } from './bridge-server';
import { SessionBus } from './session-bus';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db';
import { PairingStore } from './pairing-store';

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
