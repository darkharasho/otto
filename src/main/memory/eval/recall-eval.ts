import type { Database } from 'better-sqlite3';
import type { Embedder } from '../../embeddings/embedder';
import { FactRepo } from '../../db/fact-repo';
import { ArtifactRepo } from '../../db/artifact-repo';
import { MemorySearch } from '../search';
import { GOLDEN_FACTS, GOLDEN_ARTIFACTS, GOLDEN_QUERIES } from './golden';

export interface QueryMiss {
  query: string;
  expectedKey: string;
  note: string;
  /** Bodies of what ranked in the top K instead. */
  got: string[];
}

export interface RecallEvalResult {
  /** Fraction of expected hits found in the top K, across all queries. */
  recallAtK: number;
  /** Mean reciprocal rank of the FIRST expected hit per query. */
  mrr: number;
  k: number;
  queries: number;
  /**
   * True when every golden fact/artifact survived seeding as a distinct row.
   * False means write-time semantic dedup collapsed distinct memories —
   * the dedup threshold is too aggressive.
   */
  corpusIntact: boolean;
  misses: QueryMiss[];
}

/**
 * Seed a fresh DB with the golden corpus through the real repos (write-time
 * dedup and all), then run every golden query through the real MemorySearch
 * stack and measure recall@K and MRR against the expected hits.
 */
export async function runRecallEval(
  db: Database,
  embedder: Embedder,
  k = 5
): Promise<RecallEvalResult> {
  const now = 1_750_000_000_000;
  const factRepo = new FactRepo(db, () => now, embedder);
  const artifactRepo = new ArtifactRepo(db, () => now, embedder);

  const factIdByKey = new Map<string, string>();
  for (const f of GOLDEN_FACTS) {
    const { id } = await factRepo.upsert({ body: f.body });
    factIdByKey.set(f.key, id);
  }
  const artifactIdByKey = new Map<string, string>();
  for (const a of GOLDEN_ARTIFACTS) {
    const id = await artifactRepo.upsert({ kind: a.kind, title: a.title, body: a.body, tags: a.tags });
    artifactIdByKey.set(a.key, id);
  }
  const distinctIds = new Set([...factIdByKey.values(), ...artifactIdByKey.values()]);
  const corpusIntact = distinctIds.size === GOLDEN_FACTS.length + GOLDEN_ARTIFACTS.length;

  const search = new MemorySearch({ factRepo, artifactRepo, embedder, db });

  let expectedTotal = 0;
  let foundTotal = 0;
  let rrSum = 0;
  const misses: QueryMiss[] = [];

  for (const q of GOLDEN_QUERIES) {
    const out = await search.search({ query: q.query, limit: k });
    // One merged ranked list: facts first then artifacts mirrors what the
    // model sees in the recall tool result.
    const rankedIds = [...out.facts.map((f) => f.id), ...out.artifacts.map((a) => a.id)];
    const rankedBodies = [
      ...out.facts.map((f) => f.body),
      ...out.artifacts.map((a) => a.title),
    ];

    let bestRank: number | null = null;
    for (const key of q.expected) {
      expectedTotal += 1;
      const id = factIdByKey.get(key) ?? artifactIdByKey.get(key);
      const rank = id ? rankedIds.indexOf(id) : -1;
      if (rank >= 0) {
        foundTotal += 1;
        if (bestRank === null || rank < bestRank) bestRank = rank;
      } else {
        misses.push({ query: q.query, expectedKey: key, note: q.note, got: rankedBodies });
      }
    }
    rrSum += bestRank === null ? 0 : 1 / (bestRank + 1);
  }

  return {
    recallAtK: expectedTotal === 0 ? 0 : foundTotal / expectedTotal,
    mrr: GOLDEN_QUERIES.length === 0 ? 0 : rrSum / GOLDEN_QUERIES.length,
    k,
    queries: GOLDEN_QUERIES.length,
    corpusIntact,
    misses,
  };
}
