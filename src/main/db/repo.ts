import type { Database } from 'better-sqlite3';
import type { Message, SessionMeta, ContentBlock } from '@shared/messages';

export interface CreateSessionArgs {
  id: string;
  model: string;
  createdAt: number;
  lastActive: number;
}

interface SessionRow {
  id: string;
  title: string | null;
  created_at: number;
  last_active: number;
  model: string;
  status: 'active' | 'idle' | 'ended';
}

interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at: number;
}

export class Repo {
  constructor(private readonly db: Database) {}

  createSession(args: CreateSessionArgs): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, created_at, last_active, model, status)
         VALUES (?, NULL, ?, ?, ?, 'active')`
      )
      .run(args.id, args.createdAt, args.lastActive, args.model);
  }

  setSessionTitleIfMissing(id: string, title: string): void {
    this.db
      .prepare(`UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL`)
      .run(title, id);
  }

  updateSessionActivity(id: string, lastActive: number, status: SessionMeta['status']): void {
    this.db
      .prepare(`UPDATE sessions SET last_active = ?, status = ? WHERE id = ?`)
      .run(lastActive, status, id);
  }

  listSessions(limit = 100): SessionMeta[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY last_active DESC LIMIT ?`)
      .all(limit) as SessionRow[];
    return rows.map(rowToMeta);
  }

  getSession(id: string): SessionMeta | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    return row ? rowToMeta(row) : null;
  }

  appendMessage(m: Message & { sessionId: string }): Message {
    const nextSeq = this.nextSeq(m.sessionId);
    const stored: Message = { ...m, seq: nextSeq };
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, role, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(stored.id, m.sessionId, nextSeq, stored.role, JSON.stringify(messageBody(stored)), stored.createdAt);
    return stored;
  }

  loadMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC`)
      .all(sessionId) as MessageRow[];
    return rows.map((r) => rowToMessage(r));
  }

  private nextSeq(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(seq) AS m FROM messages WHERE session_id = ?`)
      .get(sessionId) as { m: number | null };
    return (row.m ?? -1) + 1;
  }
}

function rowToMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    lastActive: row.last_active,
    model: row.model,
    status: row.status,
  };
}

interface MessageBody {
  content: ContentBlock[];
  cancelled?: boolean;
  errored?: boolean;
}

function messageBody(m: Message): MessageBody {
  if (m.role === 'assistant') {
    return { content: m.content, cancelled: m.cancelled, errored: m.errored };
  }
  return { content: m.content };
}

function rowToMessage(row: MessageRow): Message {
  const body = JSON.parse(row.content) as MessageBody;
  const base = {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    createdAt: row.created_at,
    content: body.content,
  };
  if (row.role === 'assistant') {
    return {
      ...base,
      role: 'assistant',
      cancelled: body.cancelled ?? false,
      errored: body.errored ?? false,
    };
  }
  if (row.role === 'tool') return { ...base, role: 'tool' };
  return { ...base, role: 'user' };
}
