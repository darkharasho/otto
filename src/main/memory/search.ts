import type { Database } from 'better-sqlite3';
import type { Embedder } from '../embeddings/embedder';
import type { Fact, FactRepo } from '../db/fact-repo';
import type { Artifact, ArtifactKind, ArtifactRepo } from '../db/artifact-repo';
import { sanitizeFtsQuery } from '../db/fts-utils';
import { logger } from '../logger';

const K_FTS = 30;
const K_VEC = 30;
const RRF_K = 60;

export type MemoryKind = 'fact' | ArtifactKind;

export interface MemorySearchArgs {
  query: string;
  kinds?: MemoryKind[];
  limit: number;
}

export interface MemorySearchResult {
  facts: Fact[];
  artifacts: Artifact[];
}

export interface MemorySearchDeps {
  factRepo: FactRepo;
  artifactRepo: ArtifactRepo;
  embedder: Embedder;
  db: Database;
}

export class MemorySearch {
  private vectorDisabled = false;

  constructor(private readonly deps: MemorySearchDeps) {}

  async search(args: MemorySearchArgs): Promise<MemorySearchResult> {
    const query = args.query.trim();
    if (!query) return { facts: [], artifacts: [] };
    const kinds =
      args.kinds && args.kinds.length > 0
        ? args.kinds
        : (['fact', 'playbook', 'anti_pattern', 'heuristic'] as MemoryKind[]);
    const wantFact = kinds.includes('fact');
    const artifactKinds = kinds.filter((k) => k !== 'fact') as ArtifactKind[];

    let queryVec: Float32Array | null = null;
    if (!this.vectorDisabled) {
      try {
        queryVec = await this.deps.embedder.embed(query);
      } catch (err) {
        this.vectorDisabled = true;
        logger.warn(
          `memory search vector path disabled: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const factIds = wantFact ? this.fuseForKind('fact', query, queryVec) : [];
    const artifactIdsByKind = new Map<ArtifactKind, string[]>();
    for (const k of artifactKinds) {
      artifactIdsByKind.set(k, this.fuseForKind(k, query, queryVec));
    }

    const facts: Fact[] = factIds
      .slice(0, args.limit)
      .map((id) => this.deps.factRepo.get(id))
      .filter((f): f is Fact => f !== null);
    if (facts.length > 0) {
      this.deps.factRepo.bumpUse(
        facts.map((f) => f.id),
        'recall'
      );
    }

    const artifacts: Artifact[] = [];
    for (const k of artifactKinds) {
      const ids = artifactIdsByKind.get(k) ?? [];
      for (const id of ids) {
        const a = this.deps.artifactRepo.get(id);
        if (a && !a.archived) {
          artifacts.push(a);
          this.deps.artifactRepo.bumpUse(id);
        }
      }
    }
    artifacts.splice(args.limit);

    return { facts, artifacts };
  }

  private fuseForKind(kind: MemoryKind, query: string, queryVec: Float32Array | null): string[] {
    const ftsIds = this.ftsRank(kind, query);
    const vecIds = queryVec ? this.vecRank(kind, queryVec) : [];
    const score = new Map<string, number>();
    ftsIds.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
    vecIds.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
    return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  private ftsRank(kind: MemoryKind, query: string): string[] {
    const q = sanitizeFtsQuery(query);
    if (!q) return [];
    if (kind === 'fact') {
      return (
        this.deps.db
          .prepare(
            `SELECT fact.id AS id FROM fact_fts
                    JOIN fact ON fact.rowid = fact_fts.rowid
                   WHERE fact_fts MATCH ?
                   ORDER BY rank LIMIT ?`
          )
          .all(q, K_FTS) as Array<{ id: string }>
      ).map((r) => r.id);
    }
    return (
      this.deps.db
        .prepare(
          `SELECT artifact.id AS id FROM artifact_fts
                  JOIN artifact ON artifact.rowid = artifact_fts.rowid
                 WHERE artifact_fts MATCH ? AND artifact.kind = ? AND artifact.archived = 0
                 ORDER BY rank LIMIT ?`
        )
        .all(q, kind, K_FTS) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  private vecRank(kind: MemoryKind, queryVec: Float32Array): string[] {
    try {
      const buf = Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);
      // sqlite-vec does not support filtering by auxiliary columns (like `kind`)
      // in the KNN WHERE clause, so we fetch a larger window and filter in app code.
      const rows = this.deps.db
        .prepare(
          `SELECT ref_id, kind FROM memory_vec
                   WHERE embedding MATCH ? AND k = ?
                   ORDER BY distance`
        )
        .all(buf, K_VEC * 4) as Array<{ ref_id: string; kind: string }>;
      return rows.filter((r) => r.kind === kind).slice(0, K_VEC).map((r) => r.ref_id);
    } catch (err) {
      logger.warn(
        `vec rank failed for kind ${kind}: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }
}
