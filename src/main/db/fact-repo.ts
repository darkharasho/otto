import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { normalizeFactLine } from '../knowledge/dedup';
import { sanitizeFtsQuery } from './fts-utils';

export const PINNED_BUDGET = 40;
export const SCORE_HALF_LIFE_MS = 21 * 86_400_000;
export const PROMOTION_THRESHOLD = 3;
export const BOOTSTRAP_PREFERENCE_SESSIONS = 2;

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
  };
}

export { sanitizeFtsQuery } from './fts-utils';

export class FactRepo {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now
  ) {}

  upsert(input: UpsertInput): UpsertResult {
    const bodyTrimmed = input.body.trim();
    const bodyNorm = normalizeFactLine(bodyTrimmed);
    if (!bodyNorm) throw new Error('FactRepo.upsert: empty body');

    const existing = this.db
      .prepare('SELECT id FROM fact WHERE body_norm = ? LIMIT 1')
      .get(bodyNorm) as { id: string } | undefined;
    if (existing) return { id: existing.id, inserted: false };

    const id = randomUUID();
    const distinctSessions = input.preference ? BOOTSTRAP_PREFERENCE_SESSIONS : 0;
    const createdAt = input.createdAt ?? this.now();
    const pinned = input.pinned ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO fact
          (id, body, body_norm, pinned, use_count, distinct_sessions, score,
           created_at, last_used_at, source_session_id)
         VALUES (?, ?, ?, ?, 0, ?, 0, ?, NULL, ?)`
      )
      .run(id, bodyTrimmed, bodyNorm, pinned, distinctSessions, createdAt, input.sourceSessionId ?? null);
    return { id, inserted: true };
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

  search(args: { query: string; limit: number }): Fact[] {
    const q = sanitizeFtsQuery(args.query);
    if (!q) return [];
    const sql = `
      SELECT fact.* FROM fact_fts
        JOIN fact ON fact.rowid = fact_fts.rowid
       WHERE fact_fts MATCH ?
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

  rerank(): { promoted: string[]; demoted: string[] } {
    const now = this.now();
    const rows = this.db
      .prepare('SELECT id, pinned, distinct_sessions, last_used_at, created_at FROM fact')
      .all() as Array<{
        id: string;
        pinned: number;
        distinct_sessions: number;
        last_used_at: number | null;
        created_at: number;
      }>;

    const scored = rows.map((r) => ({
      id: r.id,
      wasPinned: r.pinned === 1,
      score: this.computeScore(r.distinct_sessions, r.last_used_at, r.created_at, now),
      createdAt: r.created_at,
    }));

    // Sort by score DESC, tiebreak by created_at DESC (newer wins on cold start).
    scored.sort((a, b) => (b.score - a.score) || (b.createdAt - a.createdAt));

    const newPinned = new Set(scored.slice(0, PINNED_BUDGET).map((s) => s.id));

    const updateScore = this.db.prepare('UPDATE fact SET score = ?, pinned = ? WHERE id = ?');
    const promoted: string[] = [];
    const demoted: string[] = [];
    const txn = this.db.transaction(() => {
      for (const s of scored) {
        const shouldPin = newPinned.has(s.id);
        if (shouldPin && !s.wasPinned) promoted.push(s.id);
        if (!shouldPin && (s.wasPinned || rows.length > PINNED_BUDGET)) demoted.push(s.id);
        updateScore.run(s.score, shouldPin ? 1 : 0, s.id);
      }
    });
    txn();
    return { promoted, demoted };
  }

  listPinned(): Fact[] {
    const rows = this.db
      .prepare('SELECT * FROM fact WHERE pinned = 1 ORDER BY score DESC')
      .all() as Row[];
    return rows.map(rowToFact);
  }
}
