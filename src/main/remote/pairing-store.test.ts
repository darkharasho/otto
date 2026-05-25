import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../db/db';
import { PairingStore } from './pairing-store';

let dir: string;
let db: Database;
let store: PairingStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-pairing-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  store = new PairingStore(db, () => 1000);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('PairingStore', () => {
  it('issues a token and verifies it back', async () => {
    const { deviceId, token } = await store.issue('iPhone');
    const found = await store.verify(token);
    expect(found?.id).toBe(deviceId);
    expect(found?.label).toBe('iPhone');
  });

  it('verify returns null for an unknown token', async () => {
    expect(await store.verify('not-a-token')).toBeNull();
  });

  it('revoked devices fail verification and cannot reconnect', async () => {
    const { deviceId, token } = await store.issue('iPhone');
    store.revoke(deviceId);
    expect(await store.verify(token)).toBeNull();
  });

  it('list returns devices with paired_at and last_seen_at', async () => {
    await store.issue('iPhone');
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.pairedAt).toBe(1000);
    expect(list[0]!.lastSeenAt).toBeNull();
  });

  it('verify updates last_seen_at', async () => {
    const { token } = await store.issue('iPhone');
    let now = 1000;
    const store2 = new PairingStore(db, () => now);
    now = 2000;
    await store2.verify(token);
    expect(store2.list()[0]!.lastSeenAt).toBe(2000);
  });
});
