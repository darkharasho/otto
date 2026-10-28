import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../logger', () => ({ logger: { warn: vi.fn() } }));

import { openDatabase } from '../db/db';
import { PeerStore, safeStorageCipher, type TokenCipher } from './peer-store';
import { logger } from '../logger';

const fakeCipher: TokenCipher = {
  encrypt: (s) => ({ data: Buffer.from(`enc:${s}`), encrypted: true }),
  decrypt: (d) => d.toString().replace(/^enc:/, ''),
};

let dir: string;
let db: Database;
let store: PeerStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-peers-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  store = new PeerStore(db, fakeCipher, () => 1234);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (name: string) =>
  store.add({ name, baseUrl: `http://${name}:17829`, deviceId: 'dev', token: `tok-${name}` });

describe('PeerStore', () => {
  it('adds and lists a peer without exposing the token', () => {
    const p = add('bazzite');
    expect(p).toMatchObject({ name: 'bazzite', baseUrl: 'http://bazzite:17829', deviceId: 'dev', pairedAt: 1234 });
    expect(store.list()).toEqual([p]);
    expect(JSON.stringify(store.list())).not.toContain('tok-bazzite');
  });

  it('returns the plaintext token', () => {
    const p = add('bazzite');
    expect(store.token(p.id)).toBe('tok-bazzite');
  });

  it('throws for an unknown token id', () => {
    expect(() => store.token('nope')).toThrow();
  });

  it('rejects duplicate names in any case', () => {
    add('bazzite');
    expect(() => add('BAZZITE')).toThrow('A machine named "BAZZITE" is already paired');
  });

  it('finds by exact name, case-insensitively', () => {
    const p = add('bazzite');
    add('baz');
    expect(store.findByName('BAZ')?.name).toBe('baz');
    expect(store.findByName('Bazzite')?.id).toBe(p.id);
  });

  it('finds by unique prefix, null when ambiguous or missing', () => {
    add('bazzite');
    add('basement');
    expect(store.findByName('BAZ')?.name).toBe('bazzite');
    expect(store.findByName('ba')).toBeNull();
    expect(store.findByName('zzz')).toBeNull();
  });

  it('removes a peer', () => {
    const p = add('bazzite');
    store.remove(p.id);
    expect(store.list()).toEqual([]);
  });
});

describe('safeStorageCipher', () => {
  it('falls back to plaintext and warns once when encryption is unavailable', () => {
    const c = safeStorageCipher();
    const r = c.encrypt('secret');
    expect(r.encrypted).toBe(false);
    expect(c.decrypt(r.data, false)).toBe('secret');
    c.encrypt('again');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
