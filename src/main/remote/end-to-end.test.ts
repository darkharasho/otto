// Node-level wire-protocol E2E; for browser-level coverage of the PWA UI,
// see the manual smoke checklist in
// `docs/superpowers/notes/2026-05-24-iphone-remote-manual-smoke.md`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { openDatabase } from '../db/db';
import { PairingStore } from './pairing-store';
import { SessionBus } from './session-bus';
import { BridgeServer } from './bridge-server';

let dirs: string[];
let server: BridgeServer | null = null;

beforeEach(() => { dirs = []; });
afterEach(async () => {
  if (server) await server.stop();
  server = null;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function setup(opts: { pwaDir?: string | null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'otto-e2e-'));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, 'otto.db'));
  const pairing = new PairingStore(db, () => 1000);
  const bus = new SessionBus();
  const resolved: Array<{ decisionId: string; choice: string }> = [];
  return {
    pairing,
    bus,
    resolved,
    makeServer: () => new BridgeServer({
      tailnetIp: '127.0.0.1',
      pairing,
      bus,
      pwaDir: opts.pwaDir ?? null,
      screenshotSecret: 'e2e-secret',
      loadScreenshot: async () => null,
      activeSessionId: () => 's1',
      resolveApproval: (id, choice) => { resolved.push({ decisionId: id, choice }); return true; },
    }),
  };
}

function openAuthedWs(port: number, token: string): Promise<{ ws: WebSocket; messages: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token })));
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      messages.push(m);
      if (m.type === 'auth_ok') resolve({ ws, messages });
    });
    ws.on('error', reject);
  });
}

describe('Remote bridge end-to-end', () => {
  it('full flow: pair -> auth -> live event -> prompt -> approval -> reconnect backfill', async () => {
    const { bus, resolved, makeServer } = setup();
    server = makeServer();
    const { port } = await server.start();

    // 1. Mint a pairing code and pair.
    const code = server.mintPairingCode();
    const pairRes = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceLabel: 'iPhone E2E' }),
    });
    expect(pairRes.status).toBe(200);
    const { token } = (await pairRes.json()) as { token: string };

    // 2. Open WS and auth.
    const { ws, messages } = await openAuthedWs(port, token);

    // 3. Bus publishes a live event -> WS receives it.
    bus.publish('s1', { type: 'event', kind: 'text-delta', text: 'hello' });
    await new Promise((r) => setTimeout(r, 30));
    expect(messages.some((m) => m.type === 'event' && m.kind === 'text-delta' && m.text === 'hello')).toBe(true);

    // 4. Phone sends a prompt -> bus input handler observes it.
    const promptsSeen: unknown[] = [];
    bus.setInputHandler('s1', async (m) => { promptsSeen.push(m); });
    ws.send(JSON.stringify({ v: 1, type: 'prompt', sessionId: 's1', text: 'hi from phone' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(promptsSeen).toContainEqual(expect.objectContaining({ type: 'prompt', text: 'hi from phone', origin: 'remote' }));

    // 5. Phone resolves an approval.
    ws.send(JSON.stringify({ v: 1, type: 'approval', decisionId: 'd-7', decision: 'approve' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toEqual([{ decisionId: 'd-7', choice: 'approve' }]);

    // 6. Close -> reconnect -> backfill catches the missed event.
    ws.close();
    await new Promise((r) => setTimeout(r, 20));
    bus.publish('s1', { type: 'event', kind: 'text-delta', text: ' world' });
    const historyRes = await fetch(`http://127.0.0.1:${port}/history?session_id=s1&since=1`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const history = (await historyRes.json()) as { events: Array<{ seq: number; event: { kind?: string; text?: string } }>; truncated: boolean };
    expect(history.events.some((e) => e.event.kind === 'text-delta' && e.event.text === ' world')).toBe(true);
    expect(history.truncated).toBe(false);
  });

  it('serves SPA index.html for an unknown path when pwaDir is provided', async () => {
    const pwaDir = mkdtempSync(path.join(tmpdir(), 'otto-pwa-'));
    dirs.push(pwaDir);
    writeFileSync(path.join(pwaDir, 'index.html'), '<!doctype html><title>Otto Remote</title>');
    const { makeServer } = setup({ pwaDir });
    server = makeServer();
    const { port } = await server.start();

    const root = await fetch(`http://127.0.0.1:${port}/`);
    expect(root.status).toBe(200);
    expect((await root.text()).includes('Otto Remote')).toBe(true);

    const deepLink = await fetch(`http://127.0.0.1:${port}/some/deep/route`);
    expect(deepLink.status).toBe(200);
    expect((await deepLink.text()).includes('Otto Remote')).toBe(true);
  });
});
