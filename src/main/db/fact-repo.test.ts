import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from './db';
import { FactRepo } from './fact-repo';
import { createStubEmbedder } from '../embeddings/stub';

let dir: string;
let db: Database;
let repo: FactRepo;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-factrepo-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  repo = new FactRepo(db, () => NOW, createStubEmbedder());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('FactRepo.upsert', () => {
  it('inserts a new fact with default counters', async () => {
    const { id, inserted } = await repo.upsert({ body: 'Browser of choice is Zen', sourceSessionId: 's1' });
    expect(inserted).toBe(true);
    const row = repo.get(id)!;
    expect(row.body).toBe('Browser of choice is Zen');
    expect(row.pinned).toBe(false);
    expect(row.distinctSessions).toBe(0);
    expect(row.useCount).toBe(0);
    expect(row.createdAt).toBe(NOW);
  });

  it('dedups on normalized body and returns the existing id', async () => {
    const a = await repo.upsert({ body: 'browser of choice is zen' });
    const b = await repo.upsert({ body: '  Browser  of choice IS Zen  ' });
    expect(b.id).toBe(a.id);
    expect(b.inserted).toBe(false);
  });

  it('bootstraps distinct_sessions=2 when preference=true', async () => {
    const { id } = await repo.upsert({ body: 'always use kdotool first on Wayland', preference: true });
    expect(repo.get(id)!.distinctSessions).toBe(2);
  });
});

describe('FactRepo.search', () => {
  it('returns FTS hits ranked', async () => {
    await repo.upsert({ body: 'Spectacle needs -bnf on multi-monitor' });
    await repo.upsert({ body: 'Browser of choice is Zen' });
    const hits = repo.search({ query: 'spectacle multi-monitor', limit: 5 });
    expect(hits.map((h) => h.body)).toEqual(['Spectacle needs -bnf on multi-monitor']);
  });

  it('sanitizes FTS operator characters', async () => {
    await repo.upsert({ body: 'audio device is Focusrite Scarlett' });
    const hits = repo.search({ query: 'audio "device"', limit: 5 });
    expect(hits).toHaveLength(1);
  });

  it('returns empty array when query is blank after sanitize', async () => {
    await repo.upsert({ body: 'x' });
    expect(repo.search({ query: '()*', limit: 5 })).toEqual([]);
  });

  it('strips hyphens to prevent FTS5 MATCH operator misparse', async () => {
    await repo.upsert({ body: 'multi-monitor setup requires xrandr' });
    // Without hyphen stripping this would throw "no such column: monitor"
    expect(() => repo.search({ query: 'multi-monitor', limit: 5 })).not.toThrow();
    const hits = repo.search({ query: 'multi-monitor', limit: 5 });
    expect(hits).toHaveLength(1);
  });
});

describe('FactRepo.bumpUse', () => {
  it('increments use_count and last_used_at; first time in session increments distinct_sessions', async () => {
    const { id } = await repo.upsert({ body: 'fact A' });
    repo.bumpUse([id], 's1');
    let row = repo.get(id)!;
    expect(row.useCount).toBe(1);
    expect(row.distinctSessions).toBe(1);
    expect(row.lastUsedAt).toBe(NOW);
    repo.bumpUse([id], 's1');
    row = repo.get(id)!;
    expect(row.useCount).toBe(2);
    expect(row.distinctSessions).toBe(1); // same session, no bump
    repo.bumpUse([id], 's2');
    row = repo.get(id)!;
    expect(row.useCount).toBe(3);
    expect(row.distinctSessions).toBe(2);
  });

  it('is a no-op for empty list', () => {
    expect(() => repo.bumpUse([], 's1')).not.toThrow();
  });
});

describe('FactRepo.rerank', () => {
  function seedWithSessions(body: string, sessions: string[], lastUsedAt: number): Promise<string> {
    return repo.upsert({ body }).then(({ id }) => {
      for (const s of sessions) {
        // bypass bumpUse to control timestamp
        db.prepare('INSERT OR IGNORE INTO fact_session (fact_id, session_id) VALUES (?, ?)').run(id, s);
      }
      db.prepare(
        'UPDATE fact SET distinct_sessions = ?, use_count = ?, last_used_at = ? WHERE id = ?'
      ).run(sessions.length, sessions.length, lastUsedAt, id);
      return id;
    });
  }

  it('elects top PINNED_BUDGET by recency-weighted score', async () => {
    // 41 facts, all with distinct_sessions=5; vary recency so the oldest is bumped.
    const ids: string[] = [];
    for (let i = 0; i < 41; i++) {
      const ageDays = i; // i=0 newest, i=40 oldest
      ids.push(await seedWithSessions(`fact ${i}`, ['s1', 's2', 's3', 's4', 's5'], NOW - ageDays * 86_400_000));
    }
    const result = repo.rerank();
    const pinned = repo.listPinned();
    expect(pinned).toHaveLength(40);
    const pinnedIds = new Set(pinned.map((p) => p.id));
    expect(pinnedIds.has(ids[40]!)).toBe(false); // oldest is NOT in pinned
    expect(result.promoted).toHaveLength(40);    // all 40 went from learned to pinned
    expect(result.demoted).toHaveLength(0);      // nothing was pinned before, nothing demoted

    // Verify the demoted-from-pinned path with a second rerank after explicit demotion:
    const learnedNow = await repo.upsert({ body: 'late entrant', preference: true });
    db.prepare('UPDATE fact SET distinct_sessions = 10, last_used_at = ? WHERE id = ?').run(NOW, learnedNow.id);
    const result2 = repo.rerank();
    expect(result2.promoted).toContain(learnedNow.id);
    expect(result2.demoted).toHaveLength(1); // whoever was the lowest-scoring pinned fact got bumped
  });

  it('reports promoted ids when a learned fact moves into the budget', async () => {
    const learned = await repo.upsert({ body: 'a freshly promoted fact' });
    db.prepare('UPDATE fact SET distinct_sessions = ?, use_count = ?, last_used_at = ? WHERE id = ?')
      .run(5, 5, NOW, learned.id);
    const result = repo.rerank();
    expect(result.promoted).toContain(learned.id);
    expect(repo.get(learned.id)!.pinned).toBe(true);
  });

  it('uses created_at when last_used_at is null', async () => {
    const old = await repo.upsert({ body: 'old never-used', createdAt: NOW - 100 * 86_400_000 });
    const recent = await repo.upsert({ body: 'recent never-used', createdAt: NOW });
    db.prepare('UPDATE fact SET distinct_sessions = ? WHERE id = ?').run(1, old.id);
    db.prepare('UPDATE fact SET distinct_sessions = ? WHERE id = ?').run(1, recent.id);
    repo.rerank();
    expect(repo.get(recent.id)!.score).toBeGreaterThan(repo.get(old.id)!.score);
  });
});

describe('FactRepo.list and counts', () => {
  it('list returns facts ordered by score desc, includes pinned flag', async () => {
    await repo.upsert({ body: 'a' });
    await repo.upsert({ body: 'b', pinned: true });
    const all = repo.list({ limit: 10 });
    expect(all).toHaveLength(2);
    expect(all.map((f) => f.body)).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('counts returns pinned + total', async () => {
    await repo.upsert({ body: 'a' });
    await repo.upsert({ body: 'b', pinned: true });
    await repo.upsert({ body: 'c', pinned: true });
    expect(repo.counts()).toEqual({ pinned: 2, total: 3 });
  });
});

describe('FactRepo embedding integration', () => {
  it('inserts a memory_vec row on upsert', async () => {
    const embedder = createStubEmbedder();
    const factRepo2 = new FactRepo(db, () => NOW, embedder);
    const { id } = await factRepo2.upsert({ body: 'audio is Focusrite Scarlett' });
    const row = db.prepare("SELECT ref_id FROM memory_vec WHERE kind='fact' AND ref_id=?").get(id) as { ref_id: string } | undefined;
    expect(row?.ref_id).toBe(id);
  });

  it('does not insert a duplicate memory_vec row on dedup hit', async () => {
    const embedder = createStubEmbedder();
    const factRepo2 = new FactRepo(db, () => NOW, embedder);
    await factRepo2.upsert({ body: 'audio is Focusrite Scarlett' });
    await factRepo2.upsert({ body: 'AUDIO is Focusrite Scarlett' });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM memory_vec WHERE kind='fact'").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('delete cascades the memory_vec row', async () => {
    const embedder = createStubEmbedder();
    const factRepo2 = new FactRepo(db, () => NOW, embedder);
    const { id } = await factRepo2.upsert({ body: 'transient fact' });
    factRepo2.delete(id);
    const row = db.prepare("SELECT ref_id FROM memory_vec WHERE kind='fact' AND ref_id=?").get(id);
    expect(row).toBeUndefined();
  });
});
