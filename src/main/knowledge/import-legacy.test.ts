import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../db/db';
import { FactRepo } from '../db/fact-repo';
import { importLegacyKnowledge } from './import-legacy';

let dir: string;
let db: Database;
let repo: FactRepo;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-import-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  repo = new FactRepo(db, () => NOW);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('importLegacyKnowledge', () => {
  it('is a no-op when knowledge.md is absent', async () => {
    await importLegacyKnowledge(dir, repo);
    expect(repo.counts().total).toBe(0);
  });

  it('parses bullet lines into pinned facts and renames the source file', async () => {
    writeFileSync(
      path.join(dir, 'knowledge.md'),
      '# Otto knowledge file\n\nDurable facts...\n\n- (2026-04-01) Browser of choice is Zen\n- (2026-04-02) Spectacle needs -bnf on multi-monitor\n'
    );
    await importLegacyKnowledge(dir, repo);
    const all = repo.list({ limit: 50 });
    expect(all.map((f) => f.body)).toEqual(
      expect.arrayContaining(['Browser of choice is Zen', 'Spectacle needs -bnf on multi-monitor'])
    );
    expect(all.every((f) => f.pinned)).toBe(true);
    // Apr 1 2026 UTC midnight
    const apr1 = Date.UTC(2026, 3, 1);
    expect(all.find((f) => f.body === 'Browser of choice is Zen')!.createdAt).toBe(apr1);
    expect(existsSync(path.join(dir, 'knowledge.md'))).toBe(false);
    expect(existsSync(path.join(dir, 'knowledge.md.pre-split.bak'))).toBe(true);
    expect(readFileSync(path.join(dir, 'knowledge.md.pre-split.bak'), 'utf8')).toContain('Zen');
  });

  it('imports non-bullet lines with created_at = now()', async () => {
    writeFileSync(path.join(dir, 'knowledge.md'), 'Just a freeform line\n');
    await importLegacyKnowledge(dir, repo);
    const all = repo.list({ limit: 50 });
    expect(all).toHaveLength(1);
    expect(all[0]!.createdAt).toBe(NOW);
  });

  it('is idempotent: a second run with the .bak in place does nothing', async () => {
    writeFileSync(path.join(dir, 'knowledge.md'), '- (2026-04-01) x\n');
    await importLegacyKnowledge(dir, repo);
    await importLegacyKnowledge(dir, repo);
    expect(repo.counts().total).toBe(1);
  });
});
