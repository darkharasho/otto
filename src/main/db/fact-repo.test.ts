import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from './db';
import { FactRepo } from './fact-repo';

let dir: string;
let db: Database;
let repo: FactRepo;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-factrepo-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  repo = new FactRepo(db, () => NOW);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('FactRepo.upsert', () => {
  it('inserts a new fact with default counters', () => {
    const { id, inserted } = repo.upsert({ body: 'Browser of choice is Zen', sourceSessionId: 's1' });
    expect(inserted).toBe(true);
    const row = repo.get(id)!;
    expect(row.body).toBe('Browser of choice is Zen');
    expect(row.pinned).toBe(false);
    expect(row.distinctSessions).toBe(0);
    expect(row.useCount).toBe(0);
    expect(row.createdAt).toBe(NOW);
  });

  it('dedups on normalized body and returns the existing id', () => {
    const a = repo.upsert({ body: 'browser of choice is zen' });
    const b = repo.upsert({ body: '  Browser  of choice IS Zen  ' });
    expect(b.id).toBe(a.id);
    expect(b.inserted).toBe(false);
  });

  it('bootstraps distinct_sessions=2 when preference=true', () => {
    const { id } = repo.upsert({ body: 'always use kdotool first on Wayland', preference: true });
    expect(repo.get(id)!.distinctSessions).toBe(2);
  });
});
