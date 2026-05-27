import { describe, it, expect, afterEach } from 'vitest';
import { BridgeServer } from './bridge-server';
import { SessionBus } from './session-bus';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db';
import { PairingStore } from './pairing-store';
import type { SessionMeta } from '@shared/messages';
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
    server = new BridgeServer({ tailnetIp: null, pairing: makeStore(), bus: new SessionBus(), pwaDir: null, screenshotSecret: 'test-secret', loadScreenshot: async () => null });
    await expect(server.start()).rejects.toThrow(/tailnet/i);
  });

  it('binds to the provided IP and serves a 404 for unknown paths', async () => {
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null, screenshotSecret: 'test-secret', loadScreenshot: async () => null });
    const { port } = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  it('binds to the requested port when specified', async () => {
    server = new BridgeServer({
      tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null,
      screenshotSecret: 'x', loadScreenshot: async () => null,
      port: 17900,
    });
    const { port } = await server.start();
    expect(port).toBe(17900);
  });
});

describe('BridgeServer /pair', () => {
  it('mints a code, accepts /pair with that code, returns a token', async () => {
    const pairing = makeStore();
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing, bus: new SessionBus(), pwaDir: null, screenshotSecret: 'test-secret', loadScreenshot: async () => null });
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
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null, screenshotSecret: 'test-secret', loadScreenshot: async () => null });
    const { port } = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'bogus', deviceLabel: 'iPhone' }),
    });
    expect(res.status).toBe(401);
  });

  it('a pairing code is single-use', async () => {
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null, screenshotSecret: 'test-secret', loadScreenshot: async () => null });
    const { port } = await server.start();
    const code = server.mintPairingCode();
    const ok = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceLabel: 'A' }) });
    expect(ok.status).toBe(200);
    const dup = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceLabel: 'B' }) });
    expect(dup.status).toBe(401);
  });

  it('rate-limits /pair to 10 requests per minute per IP', async () => {
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null, screenshotSecret: 'test-secret', loadScreenshot: async () => null });
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
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null, screenshotSecret: 'test-secret', loadScreenshot: async () => null });
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
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null, screenshotSecret: 'test-secret', loadScreenshot: async () => null });
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
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null, activeSessionId: () => 's1', screenshotSecret: 'test-secret', loadScreenshot: async () => null });
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

  it('forwards events for sessions that did not yet exist at WS auth time', async () => {
    // Regression: bridge previously subscribed only to activeSessionId() at
    // auth time, so a phone that connected before any session existed would
    // never receive events for the session subsequently started.
    const pairing = makeStore();
    const bus = new SessionBus();
    server = new BridgeServer({
      tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null,
      screenshotSecret: 'x', loadScreenshot: async () => null,
      activeSessionId: () => null, // no active session at auth time
    });
    const { port } = await server.start();
    const { token } = await pairing.issue('iPhone');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token })));
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString()) as Record<string, unknown>;
        messages.push(m);
        if (m.type === 'auth_ok') {
          // Now simulate a brand-new session starting and publishing.
          bus.publish('s-late', { type: 'event', kind: 'text-delta', text: 'after-auth' });
          setTimeout(resolve, 50);
        }
      });
    });
    ws.close();
    expect(messages.some((m) => m.type === 'event' && m.kind === 'text-delta' && m.text === 'after-auth' && m.sessionId === 's-late')).toBe(true);
  });

  it('routes inbound prompt to sendPrompt callback', async () => {
    const pairing = makeStore();
    const bus = new SessionBus();
    const seen: Array<{ text: string; origin: string; attachments: unknown[] }> = [];
    server = new BridgeServer({
      tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null,
      screenshotSecret: 'x', loadScreenshot: async () => null,
      activeSessionId: () => 's1',
      sendPrompt: async (text, origin, attachments) => { seen.push({ text, origin, attachments }); },
    });
    const { port } = await server.start();
    const { token } = await pairing.issue('iPhone');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token })));
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString());
        if (m.type === 'auth_ok') {
          ws.send(JSON.stringify({ v: 1, type: 'prompt', text: 'hi from phone' }));
          setTimeout(resolve, 50);
        }
      });
    });
    ws.close();
    expect(seen).toEqual([{ text: 'hi from phone', origin: 'remote', attachments: [] }]);
  });
});

describe('BridgeServer WS attach + prompt with attachmentIds', () => {
  it('attach frame saves the image and attach_ok comes back; subsequent prompt with attachmentId forwards the ref to sendPrompt', async () => {
    // Minimal 1×1 PNG bytes.
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
      'hex',
    );

    // Mock electron's nativeImage so saveUserUpload works outside Electron.
    const { vi } = await import('vitest');
    vi.doMock('electron', () => ({
      nativeImage: {
        createFromBuffer: () => ({ getSize: () => ({ width: 1, height: 1 }) }),
      },
    }));
    vi.resetModules();

    // Re-import BridgeServer after module reset so it picks up the mocked electron.
    const { BridgeServer: BridgeServerMocked } = await import('./bridge-server');

    const pairing = makeStore();
    const bus = new SessionBus();
    const configDir = mkdtempSync(path.join(tmpdir(), 'otto-bridge-attach-'));
    dirs.push(configDir);

    const sendPromptCalls: Array<{ text: string; origin: string; attachments: unknown[] }> = [];
    const srv = new BridgeServerMocked({
      tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null,
      screenshotSecret: 'x', loadScreenshot: async () => null,
      configDir,
      sendPrompt: async (text, origin, attachments) => { sendPromptCalls.push({ text, origin, attachments }); },
    });
    const { port } = await srv.start();
    const { token } = await pairing.issue('iPhone');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let attachOkRef: Record<string, unknown> | null = null;

    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token })));
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString()) as Record<string, unknown>;
        if (m.type === 'auth_ok') {
          // Send attach frame.
          ws.send(JSON.stringify({
            v: 1,
            type: 'attach',
            sessionId: 'sess-mobile',
            mimeType: 'image/png',
            bytesBase64: png.toString('base64'),
            clientCorrelationId: 'corr-1',
          }));
          return;
        }
        if (m.type === 'attach_ok') {
          attachOkRef = m.ref as Record<string, unknown>;
          // Send prompt with the attachment id.
          ws.send(JSON.stringify({
            v: 1,
            type: 'prompt',
            sessionId: 'sess-mobile',
            text: 'look at this',
            attachmentIds: [(m.ref as Record<string, unknown>).id],
          }));
          setTimeout(resolve, 100);
          return;
        }
        if (m.type === 'attach_err') {
          reject(new Error(`attach_err: ${String(m.message)}`));
        }
      });
    });

    ws.close();
    await srv.stop();

    vi.doUnmock('electron');
    vi.resetModules();

    expect(attachOkRef).toBeTruthy();
    expect(attachOkRef!.type).toBe('image-ref');
    expect(attachOkRef!.source).toBe('user');
    expect(sendPromptCalls).toHaveLength(1);
    expect(sendPromptCalls[0]!.text).toBe('look at this');
    expect(sendPromptCalls[0]!.origin).toBe('remote');
    expect(Array.isArray(sendPromptCalls[0]!.attachments)).toBe(true);
    expect((sendPromptCalls[0]!.attachments as unknown[]).length).toBe(1);
    expect((sendPromptCalls[0]!.attachments as Array<Record<string, unknown>>)[0]!.id).toBe(attachOkRef!.id);
  });
});

describe('BridgeServer /screenshot', () => {
  it('serves a signed screenshot URL once, then 401', async () => {
    const pairing = makeStore();
    const bus = new SessionBus();
    server = new BridgeServer({
      tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null,
      screenshotSecret: 'unit-test-secret',
      loadScreenshot: async () => Buffer.from([137, 80, 78, 71]),
    });
    const { port } = await server.start();
    const url = server.signScreenshotUrl('shot-1');
    const ok = await fetch(`http://127.0.0.1:${port}${url}`);
    expect(ok.status).toBe(200);
    const dup = await fetch(`http://127.0.0.1:${port}${url}`);
    expect(dup.status).toBe(401);
  });
});

describe('BridgeServer /image', () => {
  it('returns 404 when no image cache is configured', async () => {
    const pairing = makeStore();
    server = new BridgeServer({
      tailnetIp: '127.0.0.1', pairing, bus: new SessionBus(), pwaDir: null,
      screenshotSecret: 'x', loadScreenshot: async () => null,
    });
    const { port } = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/image?u=aGk&token=anything`);
    expect(res.status).toBe(404);
  });

  it('requires a valid bearer token in the query string', async () => {
    const pairing = makeStore();
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'otto-img-bridge-'));
    dirs.push(cacheDir);
    server = new BridgeServer({
      tailnetIp: '127.0.0.1', pairing, bus: new SessionBus(), pwaDir: null,
      screenshotSecret: 'x', loadScreenshot: async () => null,
      imageCache: { get: async () => ({ path: path.join(cacheDir, 'nope'), contentType: 'image/png' }) },
    });
    const { port } = await server.start();
    const u = Buffer.from('https://example.com/a.png', 'utf8').toString('base64url');
    const res = await fetch(`http://127.0.0.1:${port}/image?u=${u}&token=bogus`);
    expect(res.status).toBe(401);
  });

  it('serves cached bytes with the correct content-type when authorized', async () => {
    const pairing = makeStore();
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'otto-img-bridge-'));
    dirs.push(cacheDir);
    const filePath = path.join(cacheDir, 'sample.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    await import('node:fs/promises').then((m) => m.writeFile(filePath, bytes));
    server = new BridgeServer({
      tailnetIp: '127.0.0.1', pairing, bus: new SessionBus(), pwaDir: null,
      screenshotSecret: 'x', loadScreenshot: async () => null,
      imageCache: { get: async () => ({ path: filePath, contentType: 'image/png' }) },
    });
    const { port } = await server.start();
    const { token } = await pairing.issue('iPhone');
    const u = Buffer.from('https://example.com/a.png', 'utf8').toString('base64url');
    const res = await fetch(`http://127.0.0.1:${port}/image?u=${u}&token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(bytes)).toBe(true);
  });

  it('rejects when the u parameter is missing', async () => {
    const pairing = makeStore();
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'otto-img-bridge-'));
    dirs.push(cacheDir);
    server = new BridgeServer({
      tailnetIp: '127.0.0.1', pairing, bus: new SessionBus(), pwaDir: null,
      screenshotSecret: 'x', loadScreenshot: async () => null,
      imageCache: { get: async () => ({ path: '', contentType: 'image/png' }) },
    });
    const { port } = await server.start();
    const { token } = await pairing.issue('iPhone');
    const res = await fetch(`http://127.0.0.1:${port}/image?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(400);
  });
});

describe('BridgeServer approval bridging', () => {
  it('inbound approval message resolves the DecisionBroker via injected resolver', async () => {
    const pairing = makeStore();
    const bus = new SessionBus();
    const resolved: Array<{ decisionId: string; choice: string }> = [];
    server = new BridgeServer({
      tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null,
      screenshotSecret: 'x', loadScreenshot: async () => null,
      activeSessionId: () => 's1',
      resolveApproval: (id, choice) => { resolved.push({ decisionId: id, choice }); return true; },
    });
    const { port } = await server.start();
    const { token } = await pairing.issue('iPhone');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token })));
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString());
        if (m.type === 'auth_ok') {
          ws.send(JSON.stringify({ v: 1, type: 'approval', decisionId: 'd1', decision: 'approve' }));
          setTimeout(resolve, 50);
        }
      });
    });
    ws.close();
    expect(resolved).toEqual([{ decisionId: 'd1', choice: 'approve' }]);
  });
});

describe('BridgeServer /sessions', () => {
  it('GET /sessions requires auth and returns the listed sessions', async () => {
    const pairing = makeStore();
    server = new BridgeServer({
      tailnetIp: '127.0.0.1', pairing, bus: new SessionBus(), pwaDir: null,
      screenshotSecret: 'x', loadScreenshot: async () => null,
      listSessions: async (limit) => ([
        { id: 's1', title: 'Hello', createdAt: 1, lastActive: 2, model: 'm', status: 'active', sdkSessionId: null },
        { id: 's2', title: null, createdAt: 3, lastActive: 4, model: 'm', status: 'idle', sdkSessionId: null },
      ] as SessionMeta[]).slice(0, limit),
    });
    const { port } = await server.start();
    const { token } = await pairing.issue('iPhone');
    const noauth = await fetch(`http://127.0.0.1:${port}/sessions`);
    expect(noauth.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${port}/sessions?limit=10`, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { sessions: Array<{ id: string; title: string | null; status: string }> };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]).toMatchObject({ id: 's1', title: 'Hello', status: 'active' });
    expect(body.sessions[1]).toMatchObject({ id: 's2', title: null });
  });

  it('GET /sessions/:id/messages returns messages from the loader', async () => {
    const pairing = makeStore();
    server = new BridgeServer({
      tailnetIp: '127.0.0.1', pairing, bus: new SessionBus(), pwaDir: null,
      screenshotSecret: 'x', loadScreenshot: async () => null,
      loadMessages: async (sid) => [
        { id: 'm1', sessionId: sid, seq: 0, createdAt: 1, role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    });
    const { port } = await server.start();
    const { token } = await pairing.issue('iPhone');
    const noauth = await fetch(`http://127.0.0.1:${port}/sessions/abc/messages`);
    expect(noauth.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${port}/sessions/abc/messages`, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { messages: Array<{ id: string; role: string }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ id: 'm1', role: 'user' });
  });
});

describe('BridgeServer WS session control', () => {
  it('switch_session invokes the callback and replies session_switched', async () => {
    const pairing = makeStore();
    const seen: string[] = [];
    server = new BridgeServer({
      tailnetIp: '127.0.0.1', pairing, bus: new SessionBus(), pwaDir: null,
      screenshotSecret: 'x', loadScreenshot: async () => null,
      switchSession: async (sid) => { seen.push(sid); },
    });
    const { port } = await server.start();
    const { token } = await pairing.issue('iPhone');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const got = await new Promise<Record<string, unknown>>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token })));
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString()) as Record<string, unknown>;
        if (m.type === 'auth_ok') {
          ws.send(JSON.stringify({ v: 1, type: 'switch_session', sessionId: 'sX' }));
          return;
        }
        if (m.type === 'session_switched') resolve(m);
      });
    });
    ws.close();
    expect(seen).toEqual(['sX']);
    expect(got).toMatchObject({ type: 'session_switched', sessionId: 'sX' });
  });

  it('new_session invokes the callback and replies with the new session id', async () => {
    const pairing = makeStore();
    server = new BridgeServer({
      tailnetIp: '127.0.0.1', pairing, bus: new SessionBus(), pwaDir: null,
      screenshotSecret: 'x', loadScreenshot: async () => null,
      newSession: async () => 'sNew',
    });
    const { port } = await server.start();
    const { token } = await pairing.issue('iPhone');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const got = await new Promise<Record<string, unknown>>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token })));
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString()) as Record<string, unknown>;
        if (m.type === 'auth_ok') {
          ws.send(JSON.stringify({ v: 1, type: 'new_session' }));
          return;
        }
        if (m.type === 'session_switched') resolve(m);
      });
    });
    ws.close();
    expect(got).toMatchObject({ type: 'session_switched', sessionId: 'sNew' });
  });
});

describe('BridgeServer /history', () => {
  it('GET /history requires auth token and returns events from the ring', async () => {
    const pairing = makeStore();
    const bus = new SessionBus();
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null, screenshotSecret: 'test-secret', loadScreenshot: async () => null });
    const { port } = await server.start();
    const { token } = await pairing.issue('iPhone');
    bus.publish('s1', { type: 'event', kind: 'a' });
    bus.publish('s1', { type: 'event', kind: 'b' });
    const noauth = await fetch(`http://127.0.0.1:${port}/history?session_id=s1&since=0`);
    expect(noauth.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${port}/history?session_id=s1&since=0`, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { events: Array<{ seq: number }>; truncated: boolean };
    expect(body.events).toHaveLength(2);
    expect(body.truncated).toBe(false);
  });
});
