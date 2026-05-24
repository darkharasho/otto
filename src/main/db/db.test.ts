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
  it('creates schema on first open and reports latest version', () => {
    const dir = freshDir();
    const db = openDatabase(path.join(dir, 'otto.db'));
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(5);
    db.close();
  });

  it('is idempotent across reopens', () => {
    const dir = freshDir();
    const p = path.join(dir, 'otto.db');
    openDatabase(p).close();
    const db = openDatabase(p);
    const rows = db
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .all() as { version: number }[];
    // Each migration should have been applied exactly once.
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5]);
    db.close();
  });

  it('exposes sdk_session_id column on sessions after v2 migration', () => {
    const dir = freshDir();
    const db = openDatabase(path.join(dir, 'otto.db'));
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('sdk_session_id');
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

describe('migration 004 (fact + fact_session + fact_fts)', () => {
  it('runs migration 004 creating fact, fact_session, fact_fts', () => {
    const dir = freshDir();
    const db = openDatabase(path.join(dir, 'otto.db'));
    const version = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    expect(version).toBeGreaterThanOrEqual(4);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain('fact');
    expect(tables).toContain('fact_session');
    expect(tables).toContain('fact_fts');
    db.close();
  });
});

describe('migration 005 (memory_vec + sqlite-vec)', () => {
  it('runs migration 005 creating memory_vec', () => {
    const db = openDatabase(path.join(freshDir(), 'otto.db'));
    const version = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    expect(version).toBeGreaterThanOrEqual(5);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain('memory_vec');
    const v = (db.prepare('SELECT vec_version() AS v').get() as { v: string }).v;
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
    db.close();
  });
});

describe('migration 003 (artifact + FTS)', () => {
  it('bumps schema version to at least 3', () => {
    const dir = freshDir();
    const db = openDatabase(path.join(dir, 'otto.db'));
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBeGreaterThanOrEqual(3);
    db.close();
  });

  it('creates artifact table with expected columns', () => {
    const dir = freshDir();
    const db = openDatabase(path.join(dir, 'otto.db'));
    const cols = db.prepare("PRAGMA table_info(artifact)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    for (const c of [
      'id', 'kind', 'title', 'body', 'tags',
      'created_at', 'updated_at', 'source_session_id',
      'use_count', 'last_used_at', 'archived',
    ]) {
      expect(names).toContain(c);
    }
    db.close();
  });

  it('creates artifact_fts virtual table and sync triggers', () => {
    const dir = freshDir();
    const db = openDatabase(path.join(dir, 'otto.db'));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('artifact_fts');
    expect(names).toContain('artifact_ai');
    expect(names).toContain('artifact_ad');
    expect(names).toContain('artifact_au');
    db.close();
  });

  it('fts insert/search round-trips via triggers', () => {
    const dir = freshDir();
    const db = openDatabase(path.join(dir, 'otto.db'));
    db.prepare(
      `INSERT INTO artifact (id, kind, title, body, tags, created_at, updated_at, use_count, archived)
       VALUES (?, 'playbook', ?, ?, ?, ?, ?, 0, 0)`
    ).run('a1', 'fix audio stutter', '## Steps\n1. restart pipewire', '["audio","stutter"]', 1, 1);
    const hits = db
      .prepare(
        `SELECT artifact.id FROM artifact_fts
           JOIN artifact ON artifact.rowid = artifact_fts.rowid
          WHERE artifact_fts MATCH ?`
      )
      .all('stutter') as { id: string }[];
    expect(hits.map((h) => h.id)).toEqual(['a1']);
    db.close();
  });
});
