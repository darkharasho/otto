import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Embedder } from '../embeddings/embedder';
import { getEmbedder } from '../embeddings/embedder';
import { sanitizeFtsQuery } from './fts-utils';

export type ArtifactKind = 'playbook' | 'anti_pattern' | 'heuristic';

export interface ArtifactInput {
  kind: ArtifactKind;
  title: string;
  body: string;
  tags: string[];
  sourceSessionId?: string;
}

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  sourceSessionId: string | null;
  useCount: number;
  lastUsedAt: number | null;
  archived: boolean;
}

export interface ListArgs {
  kind?: ArtifactKind;
  includeArchived?: boolean;
  limit?: number;
}

export interface SearchArgs {
  query: string;
  kinds?: ArtifactKind[];
  limit: number;
}

interface Row {
  id: string;
  kind: ArtifactKind;
  title: string;
  body: string;
  tags: string;
  created_at: number;
  updated_at: number;
  source_session_id: string | null;
  use_count: number;
  last_used_at: number | null;
  archived: number;
}

function rowToArtifact(r: Row): Artifact {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    tags: JSON.parse(r.tags) as string[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sourceSessionId: r.source_session_id,
    useCount: r.use_count,
    lastUsedAt: r.last_used_at,
    archived: r.archived === 1,
  };
}

export { sanitizeFtsQuery } from './fts-utils';

export class ArtifactRepo {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly embedder: Embedder = getEmbedder()
  ) {}

  async upsert(input: ArtifactInput): Promise<string> {
    const existing = this.db
      .prepare(
        `SELECT id FROM artifact
          WHERE kind = ? AND LOWER(title) = LOWER(?) AND archived = 0
          LIMIT 1`
      )
      .get(input.kind, input.title) as { id: string } | undefined;

    const embeddingInput = `${input.title}\n${input.body}`;
    const vec = await this.embedder.embed(embeddingInput);

    const t = this.now();
    if (existing) {
      const txn = this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE artifact
                SET title = ?, body = ?, tags = ?, updated_at = ?, source_session_id = ?
              WHERE id = ?`
          )
          .run(input.title, input.body, JSON.stringify(input.tags), t, input.sourceSessionId ?? null, existing.id);
        this.db.prepare(`DELETE FROM memory_vec WHERE ref_id = ?`).run(existing.id);
        this.db.prepare(`INSERT INTO memory_vec(embedding, kind, ref_id) VALUES (?, ?, ?)`)
          .run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), input.kind, existing.id);
      });
      txn();
      return existing.id;
    }

    const id = randomUUID();
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO artifact
            (id, kind, title, body, tags, created_at, updated_at, source_session_id, use_count, archived)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
        )
        .run(id, input.kind, input.title, input.body, JSON.stringify(input.tags), t, t, input.sourceSessionId ?? null);
      this.db.prepare(`INSERT INTO memory_vec(embedding, kind, ref_id) VALUES (?, ?, ?)`)
        .run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), input.kind, id);
    });
    txn();
    return id;
  }

  get(id: string): Artifact | null {
    const row = this.db.prepare(`SELECT * FROM artifact WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToArtifact(row) : null;
  }

  list(args: ListArgs = {}): Artifact[] {
    const limit = args.limit ?? 500;
    const includeArchived = args.includeArchived ?? false;
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.kind) {
      where.push('kind = ?');
      params.push(args.kind);
    }
    if (!includeArchived) where.push('archived = 0');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM artifact ${clause} ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToArtifact);
  }

  search(args: SearchArgs): Artifact[] {
    const q = sanitizeFtsQuery(args.query);
    if (!q) return [];
    const kindFilter =
      args.kinds && args.kinds.length > 0
        ? `AND artifact.kind IN (${args.kinds.map(() => '?').join(',')})`
        : '';
    const sql = `
      SELECT artifact.* FROM artifact_fts
        JOIN artifact ON artifact.rowid = artifact_fts.rowid
       WHERE artifact_fts MATCH ?
         AND artifact.archived = 0
         ${kindFilter}
       ORDER BY rank
       LIMIT ?
    `;
    const params: unknown[] = [q];
    if (args.kinds && args.kinds.length > 0) params.push(...args.kinds);
    params.push(args.limit);
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToArtifact);
  }

  bumpUse(id: string): void {
    this.db
      .prepare(`UPDATE artifact SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`)
      .run(this.now(), id);
  }

  update(
    id: string,
    patch: { title?: string; body?: string; tags?: string[]; archived?: boolean }
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.body !== undefined) {
      sets.push('body = ?');
      params.push(patch.body);
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(patch.tags));
    }
    if (patch.archived !== undefined) {
      sets.push('archived = ?');
      params.push(patch.archived ? 1 : 0);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(this.now());
    params.push(id);
    this.db.prepare(`UPDATE artifact SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  delete(id: string): void {
    const txn = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM memory_vec WHERE ref_id=?`).run(id);
      this.db.prepare(`DELETE FROM artifact WHERE id = ?`).run(id);
    });
    txn();
  }

  counts(): { playbook: number; anti_pattern: number; heuristic: number } {
    const rows = this.db
      .prepare(`SELECT kind, COUNT(*) AS n FROM artifact WHERE archived = 0 GROUP BY kind`)
      .all() as { kind: ArtifactKind; n: number }[];
    const out = { playbook: 0, anti_pattern: 0, heuristic: 0 } as {
      playbook: number;
      anti_pattern: number;
      heuristic: number;
    };
    for (const r of rows) out[r.kind] = r.n;
    return out;
  }

  titlesForReflectorContext(): { kind: ArtifactKind; title: string; tags: string[] }[] {
    const rows = this.db
      .prepare(
        `SELECT kind, title, tags FROM artifact WHERE archived = 0 ORDER BY updated_at DESC LIMIT 200`
      )
      .all() as { kind: ArtifactKind; title: string; tags: string }[];
    return rows.map((r) => ({
      kind: r.kind,
      title: r.title,
      tags: JSON.parse(r.tags) as string[],
    }));
  }
}
