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
}
