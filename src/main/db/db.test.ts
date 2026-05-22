import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from './db';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'otto-db-'));
  tmpDirs.push(d);
  return d;
}

describe('openDatabase', () => {
  it('creates schema on first open and reports version 1', () => {
    const dir = freshDir();
    const db = openDatabase(path.join(dir, 'otto.db'));
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBe(1);
    db.close();
  });

  it('is idempotent across reopens', () => {
    const dir = freshDir();
    const p = path.join(dir, 'otto.db');
    openDatabase(p).close();
    const db = openDatabase(p);
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBe(1);
    db.close();
  });

  it('exposes sessions and messages tables', () => {
    const dir = freshDir();
    const db = openDatabase(path.join(dir, 'otto.db'));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('schema_version');
    db.close();
  });
});
