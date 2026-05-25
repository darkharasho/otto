import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db';
import { PairingStore } from './pairing-store';
import { SessionBus } from './session-bus';
import { RemoteModule } from './index';

let dirs: string[];
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function makePairing() {
  const dir = mkdtempSync(path.join(tmpdir(), 'otto-rm-'));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, 'otto.db'));
  return new PairingStore(db, () => 1000);
}

interface FakeBridge {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  startCalls: number;
}

function makeFakeBridge(opts: { throwOnce?: boolean } = {}): FakeBridge {
  let thrown = false;
  return {
    startCalls: 0,
    async start() {
      this.startCalls++;
      if (opts.throwOnce && !thrown) { thrown = true; throw new Error('boom'); }
      return { port: 9000 };
    },
    async stop() {},
  };
}

describe('RemoteModule', () => {
  it('stays down when tailnet IP is null', async () => {
    const mod = new RemoteModule({
      pairing: makePairing(),
      bus: new SessionBus(),
      resolveTailnetIp: async () => null,
      makeBridge: () => makeFakeBridge() as never,
      pollMs: 0,
    });
    await mod.start();
    const s = mod.status();
    expect(s.running).toBe(false);
    expect(s.reason ?? '').toMatch(/tailnet/i);
    await mod.stop();
  });

  it('starts the bridge when tailnet IP is present', async () => {
    const bridge = makeFakeBridge();
    const mod = new RemoteModule({
      pairing: makePairing(),
      bus: new SessionBus(),
      resolveTailnetIp: async () => '100.64.1.2',
      makeBridge: () => bridge as never,
      pollMs: 0,
    });
    await mod.start();
    expect(mod.status().running).toBe(true);
    expect(mod.status().url).toBe('http://100.64.1.2:9000');
    expect(bridge.startCalls).toBe(1);
    await mod.stop();
  });

  it('retries once if the bridge throws on first start', async () => {
    const bridge = makeFakeBridge({ throwOnce: true });
    const mod = new RemoteModule({
      pairing: makePairing(),
      bus: new SessionBus(),
      resolveTailnetIp: async () => '100.64.1.2',
      makeBridge: () => bridge as never,
      pollMs: 0,
      restartDelayMs: 1,
    });
    await mod.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.startCalls).toBe(2);
    expect(mod.status().running).toBe(true);
    await mod.stop();
  });
});
