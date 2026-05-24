import type { Database } from 'better-sqlite3';
import type { Embedder } from './embedder';
import { logger } from '../logger';

const BATCH = 32;

export interface BackfillDeps {
  db: Database;
  embedder: Embedder;
}

export async function backfillEmbeddings(deps: BackfillDeps): Promise<{ embedded: number; ms: number }> {
  const start = Date.now();
  let embedded = 0;
  try {
    embedded += await backfillKind(deps, 'fact', `SELECT id AS ref_id, body AS text FROM fact WHERE id NOT IN (SELECT ref_id FROM memory_vec WHERE kind='fact')`);
    for (const kind of ['playbook', 'anti_pattern', 'heuristic'] as const) {
      embedded += await backfillKind(
        deps,
        kind,
        `SELECT id AS ref_id, (title || char(10) || body) AS text FROM artifact WHERE kind = '${kind}' AND id NOT IN (SELECT ref_id FROM memory_vec WHERE kind='${kind}')`
      );
    }
  } catch (err) {
    logger.error('backfillEmbeddings failed', err);
  }
  const ms = Date.now() - start;
  if (embedded > 0) logger.info(`embeddings: backfilled ${embedded} rows in ${ms}ms`);
  return { embedded, ms };
}

async function backfillKind(
  deps: BackfillDeps,
  kind: string,
  sql: string
): Promise<number> {
  const rows = deps.db.prepare(sql).all() as Array<{ ref_id: string; text: string }>;
  if (rows.length === 0) return 0;
  const insert = deps.db.prepare(
    `INSERT INTO memory_vec(embedding, kind, ref_id) VALUES (?, ?, ?)`
  );
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vecs = await deps.embedder.embedBatch(batch.map((r) => r.text));
    const txn = deps.db.transaction(() => {
      for (let j = 0; j < batch.length; j += 1) {
        const v = vecs[j]!;
        insert.run(Buffer.from(v.buffer, v.byteOffset, v.byteLength), kind, batch[j]!.ref_id);
      }
    });
    txn();
  }
  return rows.length;
}
