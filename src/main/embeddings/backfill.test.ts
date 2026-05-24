import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../db/db';
import { FactRepo } from '../db/fact-repo';
import { ArtifactRepo } from '../db/artifact-repo';
import { createStubEmbedder } from './stub';
import { backfillEmbeddings } from './backfill';

let dir: string;
let db: Database;
let factRepo: FactRepo;
let artifactRepo: ArtifactRepo;

const NO_VEC_EMBEDDER = {
  dim: 384,
  isAvailable: true,
  embed: async () => new Float32Array(384),
  embedBatch: async (ts: string[]) => ts.map(() => new Float32Array(384)),
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-backfill-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  factRepo = new FactRepo(db, () => 1000, NO_VEC_EMBEDDER);
  artifactRepo = new ArtifactRepo(db, () => 1000, NO_VEC_EMBEDDER);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('backfillEmbeddings', () => {
  it('embeds previously-unembedded rows', async () => {
    await factRepo.upsert({ body: 'fact one' });
    await factRepo.upsert({ body: 'fact two' });
    await factRepo.upsert({ body: 'fact three' });
    await artifactRepo.upsert({ kind: 'playbook', title: 'P', body: 'b', tags: [] });
    // Simulate pre-embedding world: clear vectors.
    db.prepare('DELETE FROM memory_vec').run();

    const stub = createStubEmbedder();
    const out = await backfillEmbeddings({ db, embedder: stub });
    expect(out.embedded).toBe(4);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM memory_vec').get() as { n: number }).n;
    expect(n).toBe(4);
  });

  it('is a no-op on a second run', async () => {
    await factRepo.upsert({ body: 'fact' });
    db.prepare('DELETE FROM memory_vec').run();
    const stub = createStubEmbedder();
    await backfillEmbeddings({ db, embedder: stub });
    const out = await backfillEmbeddings({ db, embedder: stub });
    expect(out.embedded).toBe(0);
  });
});
