// @vitest-environment node
// (transformers.js sniffs the environment; under the project-default jsdom it
// takes the browser code path and the local ONNX model never loads)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../db/db';
import type { Embedder } from '../../embeddings/embedder';
import { runRecallEval } from './recall-eval';

/**
 * Offline recall-quality eval against the golden set, using the REAL MiniLM
 * embedder (loaded straight from resources/embedding, bypassing the
 * Electron-dependent getEmbedder). Slow (~10s model load + inference), so it
 * only runs when explicitly requested:
 *
 *   npm run eval:memory
 *
 * Treat threshold failures as a regression in search ranking, FTS
 * sanitization, dedup thresholds, or the embedding pipeline.
 */
const RUN = process.env.OTTO_MEMORY_EVAL === '1';

const DIM = 384;

async function loadRealEmbedder(): Promise<Embedder> {
  const t = (await import('@xenova/transformers')) as unknown as {
    env: { localModelPath: string; allowRemoteModels: boolean; allowLocalModels: boolean };
    pipeline: (
      task: string,
      model: string,
      opts?: { quantized?: boolean }
    ) => Promise<(text: string | string[], opts?: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>>;
  };
  t.env.localModelPath = path.join(process.cwd(), 'resources', 'embedding');
  t.env.allowRemoteModels = false;
  t.env.allowLocalModels = true;
  const pipe = await t.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
  return {
    dim: DIM,
    isAvailable: true,
    async embed(text) {
      const out = await pipe(text, { pooling: 'mean', normalize: true });
      return new Float32Array(out.data);
    },
    async embedBatch(texts) {
      const all: Float32Array[] = [];
      for (const text of texts) {
        const out = await pipe(text, { pooling: 'mean', normalize: true });
        all.push(new Float32Array(out.data));
      }
      return all;
    },
  };
}

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-recall-eval-'));
  db = openDatabase(path.join(dir, 'otto.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!RUN)('recall quality eval (golden set, real embedder)', () => {
  it('meets the recall@5 and MRR floors with an intact corpus', async () => {
    const embedder = await loadRealEmbedder();
    const result = await runRecallEval(db, embedder, 5);

    // eslint-disable-next-line no-console
    console.log(
      `[recall-eval] recall@${result.k}=${result.recallAtK.toFixed(3)} ` +
        `mrr=${result.mrr.toFixed(3)} queries=${result.queries} corpusIntact=${result.corpusIntact}`
    );
    for (const m of result.misses) {
      // eslint-disable-next-line no-console
      console.log(`[recall-eval] MISS "${m.query}" expected=${m.expectedKey} (${m.note})\n  got: ${m.got.join(' | ')}`);
    }

    // Canary: write-time semantic dedup must not collapse distinct memories.
    expect(result.corpusIntact).toBe(true);
    expect(result.recallAtK).toBeGreaterThanOrEqual(0.8);
    expect(result.mrr).toBeGreaterThanOrEqual(0.6);
  }, 120_000);
});
