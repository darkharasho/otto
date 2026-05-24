import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../db/db';
import { FactRepo } from '../db/fact-repo';
import { ArtifactRepo } from '../db/artifact-repo';
import { createStubEmbedder } from '../embeddings/stub';
import { MemorySearch } from './search';

let dir: string;
let db: Database;
let factRepo: FactRepo;
let artifactRepo: ArtifactRepo;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-msearch-'));
  db = openDatabase(path.join(dir, 'otto.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MemorySearch', () => {
  it('returns FTS hits even when vector distance is large', async () => {
    const orth1 = new Float32Array(384);
    orth1[0] = 1;
    const orth2 = new Float32Array(384);
    orth2[1] = 1;
    const embedder = createStubEmbedder({
      'spectacle needs -bnf on multi-monitor': orth1,
      'spectacle': orth2,
    });
    factRepo = new FactRepo(db, () => 1000, embedder);
    artifactRepo = new ArtifactRepo(db, () => 1000, embedder);
    await factRepo.upsert({ body: 'spectacle needs -bnf on multi-monitor' });
    const search = new MemorySearch({ factRepo, artifactRepo, embedder, db });
    const out = await search.search({ query: 'spectacle', limit: 5 });
    expect(out.facts.map((f) => f.body)).toContain('spectacle needs -bnf on multi-monitor');
  });

  it('returns vector hits when FTS misses the paraphrase', async () => {
    const shared = new Float32Array(384).fill(0.1);
    const embedder = createStubEmbedder({
      'audio is glitching': shared,
      'sound stutters during render': shared,
    });
    factRepo = new FactRepo(db, () => 1000, embedder);
    artifactRepo = new ArtifactRepo(db, () => 1000, embedder);
    await factRepo.upsert({ body: 'audio is glitching' });
    const search = new MemorySearch({ factRepo, artifactRepo, embedder, db });
    const out = await search.search({ query: 'sound stutters during render', limit: 5 });
    expect(out.facts.map((f) => f.body)).toContain('audio is glitching');
  });

  it('filters by kinds', async () => {
    const embedder = createStubEmbedder();
    factRepo = new FactRepo(db, () => 1000, embedder);
    artifactRepo = new ArtifactRepo(db, () => 1000, embedder);
    await factRepo.upsert({ body: 'common keyword' });
    await artifactRepo.upsert({ kind: 'playbook', title: 'common keyword', body: 'b', tags: [] });
    const search = new MemorySearch({ factRepo, artifactRepo, embedder, db });
    const factsOnly = await search.search({ query: 'common', kinds: ['fact'], limit: 5 });
    expect(factsOnly.artifacts).toHaveLength(0);
    expect(factsOnly.facts).toHaveLength(1);
  });

  it('falls back to FTS-only when embedder throws', async () => {
    const bad = {
      dim: 384,
      embed: async () => { throw new Error('boom'); },
      embedBatch: async () => { throw new Error('boom'); },
    };
    const goodForWrite = createStubEmbedder();
    factRepo = new FactRepo(db, () => 1000, goodForWrite);
    artifactRepo = new ArtifactRepo(db, () => 1000, goodForWrite);
    await factRepo.upsert({ body: 'unique-keyword-x' });
    const search = new MemorySearch({ factRepo, artifactRepo, embedder: bad, db });
    const out = await search.search({ query: 'unique-keyword-x', limit: 5 });
    expect(out.facts.map((f) => f.body)).toContain('unique-keyword-x');
  });

  it('returns empty result for empty query', async () => {
    const embedder = createStubEmbedder();
    factRepo = new FactRepo(db, () => 1000, embedder);
    artifactRepo = new ArtifactRepo(db, () => 1000, embedder);
    const search = new MemorySearch({ factRepo, artifactRepo, embedder, db });
    const out = await search.search({ query: '', limit: 5 });
    expect(out.facts).toEqual([]);
    expect(out.artifacts).toEqual([]);
  });
});
