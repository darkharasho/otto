import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { normalizeFactLine } from '../knowledge/dedup';
import { sanitizeFtsQuery } from './fts-utils';
import type { Embedder } from '../embeddings/embedder';
import { getEmbedder } from '../embeddings/embedder';
import { hasEmbeddingSignal } from '../embeddings/vec-utils';

export const PINNED_BUDGET = 40;
export const SCORE_HALF_LIFE_MS = 21 * 86_400_000;
export const BOOTSTRAP_PREFERENCE_SESSIONS = 2;
// Unpinned facts untouched for this long get archived by rerank(): hidden
// from search and pinning, never deleted. Re-learning un-archives.
export const ARCHIVE_AFTER_MS = 180 * 86_400_000;
// Embedding cosine similarity at/above which a new fact is the same fact in
// different words. all-MiniLM-L6-v2 paraphrases land ~0.9+; topical-but-
// distinct facts ("browser is Firefox" / "Firefox crashes on wayland") sit
// well below.
export const SEMANTIC_DUP_COSINE = 0.9;

export interface Fact {
  id: string;
  body: string;
  bodyNorm: string;
  pinned: boolean;
  useCount: number;
  distinctSessions: number;
  score: number;
  createdAt: number;
  lastUsedAt: number | null;
  sourceSessionId: string | null;
  archived: boolean;
}

export interface UpsertInput {
  body: string;
  sourceSessionId?: string;
  preference?: boolean;
  /** Override created_at — used by migration importer. */
  createdAt?: number;
  /** Override pinned — used by migration importer. */
  pinned?: boolean;
}

export interface UpsertResult {
  id: string;
  inserted: boolean;
}

interface Row {
  id: string;
  body: string;
  body_norm: string;
  pinned: number;
  use_count: number;
  distinct_sessions: number;
  score: number;
  created_at: number;
  last_used_at: number | null;
  source_session_id: string | null;
  archived: number;
}

function rowToFact(r: Row): Fact {
  return {
    id: r.id,
    body: r.body,
    bodyNorm: r.body_norm,
    pinned: r.pinned === 1,
    useCount: r.use_count,
    distinctSessions: r.distinct_sessions,
    score: r.score,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    sourceSessionId: r.source_session_id,
    archived: r.archived === 1,
  };
}

export { sanitizeFtsQuery } from './fts-utils';

export class FactRepo {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly embedder: Embedder = getEmbedder()
  ) {}

  async upsert(input: UpsertInput): Promise<UpsertResult> {
    const bodyTrimmed = input.body.trim();
    const bodyNorm = normalizeFactLine(bodyTrimmed);
    if (!bodyNorm) throw new Error('FactRepo.upsert: empty body');

    // Embed BEFORE the transaction so we don't hold a write lock across the
    // (~10ms) embed call. Also used for semantic dedup below.
    let vec: Float32Array | null = null;
    if (this.embedder.isAvailable) {
      try {
        vec = await this.embedder.embed(bodyTrimmed);
      } catch {
        vec = null;
      }
    }

    const existing = this.db
      .prepare('SELECT id FROM fact WHERE body_norm = ? LIMIT 1')
      .get(bodyNorm) as { id: string } | undefined;
    const duplicateId =
      existing?.id ??
      (vec && hasEmbeddingSignal(vec) ? this.findSemanticDuplicate(vec) : null);
    if (duplicateId) {
      // Independently re-learned: the strongest signal a fact is real and
      // current. Counts as a distinct-session use and un-archives.
      this.markRelearned(duplicateId, input.sourceSessionId);
      return { id: duplicateId, inserted: false };
    }

    const id = randomUUID();
    const distinctSessions = input.preference ? BOOTSTRAP_PREFERENCE_SESSIONS : 0;
    const createdAt = input.createdAt ?? this.now();
    const pinned = input.pinned ? 1 : 0;

    const insertFact = this.db.prepare(
      `INSERT INTO fact
        (id, body, body_norm, pinned, use_count, distinct_sessions, score,
         created_at, last_used_at, source_session_id, archived)
       VALUES (?, ?, ?, ?, 0, ?, 0, ?, NULL, ?, 0)`
    );
    const insertVec = this.db.prepare(
      `INSERT INTO memory_vec(embedding, kind, ref_id) VALUES (?, 'fact', ?)`
    );
    const txn = this.db.transaction(() => {
      insertFact.run(id, bodyTrimmed, bodyNorm, pinned, distinctSessions, createdAt, input.sourceSessionId ?? null);
      if (vec) insertVec.run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), id);
    });
    txn();
    return { id, inserted: true };
  }

  /**
   * Nearest stored fact embedding at/above SEMANTIC_DUP_COSINE, or null.
   * sqlite-vec KNN can't filter by the auxiliary `kind` column, so fetch a
   * wider window and filter in app code (same pattern as MemorySearch).
   * Vectors are normalized, so cosine = 1 − L2²/2.
   */
  private findSemanticDuplicate(vec: Float32Array): string | null {
    try {
      const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
      const rows = this.db
        .prepare(
          `SELECT ref_id, kind, distance FROM memory_vec
            WHERE embedding MATCH ? AND k = ?
            ORDER BY distance`
        )
        .all(buf, 40) as Array<{ ref_id: string; kind: string; distance: number }>;
      const best = rows.find((r) => r.kind === 'fact');
      if (!best) return null;
      const cosine = 1 - (best.distance * best.distance) / 2;
      return cosine >= SEMANTIC_DUP_COSINE ? best.ref_id : null;
    } catch {
      return null;
    }
  }

  /** Dedup hit on upsert: refresh recency, count the session, un-archive. */
  private markRelearned(id: string, sessionId?: string): void {
    const t = this.now();
    const txn = this.db.transaction(() => {
      let sessionInc = 0;
      if (sessionId) {
        const info = this.db
          .prepare('INSERT OR IGNORE INTO fact_session (fact_id, session_id) VALUES (?, ?)')
          .run(id, sessionId);
        sessionInc = info.changes === 1 ? 1 : 0;
      }
      this.db
        .prepare(
          `UPDATE fact
              SET last_used_at = ?,
                  distinct_sessions = distinct_sessions + ?,
                  archived = 0
            WHERE id = ?`
        )
        .run(t, sessionInc, id);
    });
    txn();
  }

  delete(id: string): void {
    const txn = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM memory_vec WHERE kind='fact' AND ref_id=?`).run(id);
      this.db.prepare(`DELETE FROM fact_session WHERE fact_id=?`).run(id);
      this.db.prepare(`DELETE FROM fact WHERE id=?`).run(id);
    });
    txn();
  }

  get(id: string): Fact | null {
    const row = this.db.prepare('SELECT * FROM fact WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToFact(row) : null;
  }

  bumpUse(factIds: string[], sessionId: string): void {
    if (factIds.length === 0) return;
    const t = this.now();
    const tryInsertSession = this.db.prepare(
      'INSERT OR IGNORE INTO fact_session (fact_id, session_id) VALUES (?, ?)'
    );
    const bumpRow = this.db.prepare(
      `UPDATE fact
          SET use_count = use_count + 1,
              last_used_at = ?,
              distinct_sessions = distinct_sessions + ?
        WHERE id = ?`
    );
    const txn = this.db.transaction(() => {
      for (const id of factIds) {
        const info = tryInsertSession.run(id, sessionId);
        const sessionInc = info.changes === 1 ? 1 : 0;
        bumpRow.run(t, sessionInc, id);
      }
    });
    txn();
  }

  /**
   * Recall returned this fact in search results. Recency-only signal:
   * appearing in results is NOT proof of usefulness, so it must not feed
   * distinct_sessions (which drives pinning). Genuine value signals are
   * prompt exposure (bumpUse) and independent re-learning (upsert dedup).
   */
  bumpRecall(factIds: string[]): void {
    if (factIds.length === 0) return;
    const t = this.now();
    const stmt = this.db.prepare(
      'UPDATE fact SET use_count = use_count + 1, last_used_at = ? WHERE id = ?'
    );
    const txn = this.db.transaction(() => {
      for (const id of factIds) stmt.run(t, id);
    });
    txn();
  }

  search(args: { query: string; limit: number }): Fact[] {
    const q = sanitizeFtsQuery(args.query);
    if (!q) return [];
    const sql = `
      SELECT fact.* FROM fact_fts
        JOIN fact ON fact.rowid = fact_fts.rowid
       WHERE fact_fts MATCH ? AND fact.archived = 0
       ORDER BY rank
       LIMIT ?
    `;
    return (this.db.prepare(sql).all(q, args.limit) as Row[]).map(rowToFact);
  }

  /** distinct_sessions * exp(-age_days / 21). Exported via rerank() side-effect. */
  private computeScore(distinctSessions: number, lastUsedAt: number | null, createdAt: number, now: number): number {
    const ts = lastUsedAt ?? createdAt;
    const ageMs = Math.max(0, now - ts);
    const decay = Math.exp(-ageMs / SCORE_HALF_LIFE_MS);
    return distinctSessions * decay;
  }

  rerank(): { promoted: string[]; demoted: string[]; archived: string[] } {
    const now = this.now();
    const rows = this.db
      .prepare('SELECT id, pinned, distinct_sessions, last_used_at, created_at, archived FROM fact')
      .all() as Array<{
        id: string;
        pinned: number;
        distinct_sessions: number;
        last_used_at: number | null;
        created_at: number;
        archived: number;
      }>;

    const scored = rows.map((r) => ({
      id: r.id,
      wasPinned: r.pinned === 1,
      wasArchived: r.archived === 1,
      score: this.computeScore(r.distinct_sessions, r.last_used_at, r.created_at, now),
      createdAt: r.created_at,
      lastTouched: r.last_used_at ?? r.created_at,
    }));

    // Sort by score DESC, tiebreak by created_at DESC (newer wins on cold start).
    scored.sort((a, b) => (b.score - a.score) || (b.createdAt - a.createdAt));

    // Archived facts never compete for the pinned budget.
    const newPinned = new Set(
      scored.filter((s) => !s.wasArchived).slice(0, PINNED_BUDGET).map((s) => s.id)
    );

    const updateRow = this.db.prepare(
      'UPDATE fact SET score = ?, pinned = ?, archived = ? WHERE id = ?'
    );
    const promoted: string[] = [];
    const demoted: string[] = [];
    const archived: string[] = [];
    const txn = this.db.transaction(() => {
      for (const s of scored) {
        const shouldPin = newPinned.has(s.id);
        // Staleness lifecycle: an unpinned fact untouched for ARCHIVE_AFTER_MS
        // drops out of search and pinning (never deleted; re-learning during
        // upsert un-archives it).
        const shouldArchive =
          s.wasArchived || (!shouldPin && now - s.lastTouched > ARCHIVE_AFTER_MS);
        if (shouldPin && !s.wasPinned) promoted.push(s.id);
        else if (!shouldPin && s.wasPinned) demoted.push(s.id);
        if (shouldArchive && !s.wasArchived) archived.push(s.id);
        updateRow.run(s.score, shouldPin ? 1 : 0, shouldArchive ? 1 : 0, s.id);
      }
    });
    txn();
    return { promoted, demoted, archived };
  }

  listPinned(): Fact[] {
    const rows = this.db
      .prepare('SELECT * FROM fact WHERE pinned = 1 ORDER BY score DESC')
      .all() as Row[];
    return rows.map(rowToFact);
  }

  list(args: { limit?: number } = {}): Fact[] {
    const limit = args.limit ?? 500;
    return (this.db
      .prepare('SELECT * FROM fact ORDER BY pinned DESC, score DESC, created_at DESC LIMIT ?')
      .all(limit) as Row[]).map(rowToFact);
  }

  counts(): { pinned: number; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM fact').get() as { n: number }).n;
    const pinned = (this.db.prepare('SELECT COUNT(*) AS n FROM fact WHERE pinned = 1').get() as { n: number }).n;
    return { pinned, total };
  }
}
