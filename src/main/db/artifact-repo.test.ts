import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from './db';
import { ArtifactRepo } from './artifact-repo';
import { createStubEmbedder } from '../embeddings/stub';

let dir: string;
let db: Database;
let repo: ArtifactRepo;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-artrepo-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  repo = new ArtifactRepo(db, () => 1000, createStubEmbedder());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ArtifactRepo', () => {
  it('inserts a new artifact and lists it back', async () => {
    const id = await repo.upsert({
      kind: 'playbook',
      title: 'Fix audio stutter',
      body: '## Steps\n1. restart pipewire',
      tags: ['audio', 'stutter'],
      sourceSessionId: 's1',
    });
    const all = repo.list({ kind: 'playbook' });
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(id);
    expect(all[0]!.title).toBe('Fix audio stutter');
    expect(all[0]!.tags).toEqual(['audio', 'stutter']);
    expect(all[0]!.useCount).toBe(0);
    expect(all[0]!.archived).toBe(false);
  });

  it('upsert updates existing row when (kind,title) matches case-insensitively', async () => {
    const id1 = await repo.upsert({
      kind: 'playbook',
      title: 'Fix Audio Stutter',
      body: 'v1',
      tags: ['audio'],
      sourceSessionId: 's1',
    });
    repo.bumpUse(id1);
    expect(repo.get(id1)?.useCount).toBe(1);
    const id2 = await repo.upsert({
      kind: 'playbook',
      title: 'fix audio stutter',
      body: 'v2',
      tags: ['audio', 'pipewire'],
      sourceSessionId: 's2',
    });
    expect(id2).toBe(id1);
    const row = repo.get(id1)!;
    expect(row.body).toBe('v2');
    expect(row.tags).toEqual(['audio', 'pipewire']);
    expect(row.useCount).toBe(1); // preserved
  });

  it('search returns FTS hits ordered by rank, excluding archived', async () => {
    const a = await repo.upsert({
      kind: 'playbook',
      title: 'restart pipewire',
      body: 'systemctl --user restart pipewire',
      tags: ['audio'],
    });
    await repo.upsert({
      kind: 'playbook',
      title: 'unrelated thing',
      body: 'nothing here',
      tags: [],
    });
    const archived = await repo.upsert({
      kind: 'playbook',
      title: 'old pipewire fix',
      body: 'deprecated',
      tags: [],
    });
    await repo.update(archived, { archived: true });

    const hits = repo.search({ query: 'pipewire', limit: 5 });
    expect(hits.map((h) => h.id)).toEqual([a]);
  });

  it('bumpUse increments use_count and sets last_used_at', async () => {
    const id = await repo.upsert({ kind: 'heuristic', title: 't', body: 'b', tags: [] });
    repo.bumpUse(id);
    repo.bumpUse(id);
    const row = repo.get(id)!;
    expect(row.useCount).toBe(2);
    expect(row.lastUsedAt).toBe(1000);
  });

  it('counts by kind ignore archived', async () => {
    await repo.upsert({ kind: 'playbook', title: 'p1', body: '', tags: [] });
    await repo.upsert({ kind: 'playbook', title: 'p2', body: '', tags: [] });
    const aId = await repo.upsert({ kind: 'anti_pattern', title: 'a1', body: '', tags: [] });
    await repo.update(aId, { archived: true });
    const c = repo.counts();
    expect(c).toEqual({ playbook: 2, anti_pattern: 0, heuristic: 0 });
  });

  it('sanitizes FTS query operators so user input cannot break MATCH', async () => {
    await repo.upsert({ kind: 'playbook', title: 'has parens', body: 'body', tags: [] });
    // ')(' would cause an FTS syntax error if not sanitized.
    const hits = repo.search({ query: 'has)( parens', limit: 5 });
    expect(hits).toHaveLength(1);
  });

  it('delete removes the row and its FTS entry', async () => {
    const id = await repo.upsert({ kind: 'playbook', title: 'goner', body: 'b', tags: [] });
    repo.delete(id);
    expect(repo.get(id)).toBeNull();
    expect(repo.search({ query: 'goner', limit: 5 })).toEqual([]);
  });
});

describe('ArtifactRepo embedding integration', () => {
  it('inserts a memory_vec row on upsert', async () => {
    const embedder = createStubEmbedder();
    const r = new ArtifactRepo(db, () => 1000, embedder);
    const id = await r.upsert({ kind: 'playbook', title: 'Fix audio', body: 'steps', tags: [] });
    const row = db.prepare("SELECT ref_id FROM memory_vec WHERE ref_id=?").get(id) as { ref_id?: string } | undefined;
    expect(row?.ref_id).toBe(id);
  });

  it('replaces memory_vec row on update', async () => {
    const embedder = createStubEmbedder();
    const r = new ArtifactRepo(db, () => 1000, embedder);
    const id1 = await r.upsert({ kind: 'playbook', title: 'P', body: 'v1', tags: [] });
    const id2 = await r.upsert({ kind: 'playbook', title: 'P', body: 'v2 with much more detail', tags: [] });
    expect(id2).toBe(id1);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM memory_vec WHERE ref_id=?").get(id1) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('delete cascades the memory_vec row', async () => {
    const embedder = createStubEmbedder();
    const r = new ArtifactRepo(db, () => 1000, embedder);
    const id = await r.upsert({ kind: 'playbook', title: 'P', body: 'b', tags: [] });
    r.delete(id);
    const row = db.prepare("SELECT ref_id FROM memory_vec WHERE ref_id=?").get(id);
    expect(row).toBeUndefined();
  });

  it('update re-embeds when body changes and embedding in memory_vec changes', async () => {
    const embedder = createStubEmbedder();
    const r = new ArtifactRepo(db, () => 1000, embedder);
    const id = await r.upsert({ kind: 'playbook', title: 'T', body: 'original body', tags: [] });

    const before = db.prepare("SELECT embedding FROM memory_vec WHERE ref_id=?").get(id) as { embedding: Buffer } | undefined;
    expect(before).toBeDefined();

    await r.update(id, { body: 'completely different body text' });

    const after = db.prepare("SELECT embedding FROM memory_vec WHERE ref_id=?").get(id) as { embedding: Buffer } | undefined;
    expect(after).toBeDefined();
    // The embedding bytes must differ since the text changed
    expect(Buffer.compare(before!.embedding, after!.embedding)).not.toBe(0);
  });

  it('update with only archived flag does not change memory_vec embedding', async () => {
    const embedder = createStubEmbedder();
    const r = new ArtifactRepo(db, () => 1000, embedder);
    const id = await r.upsert({ kind: 'playbook', title: 'T', body: 'body', tags: [] });

    const before = db.prepare("SELECT embedding FROM memory_vec WHERE ref_id=?").get(id) as { embedding: Buffer } | undefined;
    await r.update(id, { archived: true });
    const after = db.prepare("SELECT embedding FROM memory_vec WHERE ref_id=?").get(id) as { embedding: Buffer } | undefined;

    expect(Buffer.compare(before!.embedding, after!.embedding)).toBe(0);
  });
});
