import type { Database } from 'better-sqlite3';
import type { Message, SessionMeta } from '@shared/messages';
import { Repo, type CreateSessionArgs } from './repo';

interface PrivateEntry {
  meta: SessionMeta;
  messages: Message[];
}

/**
 * Decorates {@link Repo}: sessions created with `private: true` live entirely in
 * memory and never touch SQLite. All reads/writes for a private session id are
 * served from the in-memory map; everything else delegates to the base Repo.
 * Private sessions are intentionally absent from `listSessions` so they never
 * appear in history and leave no on-disk residue (even on a crash).
 *
 * Design notes:
 * - `deleteAllSessions` / `deleteSessionsOlderThan` are intentionally NOT
 *   overridden: they only purge persisted (SQLite) sessions. Private sessions
 *   are ephemeral — they vanish on session close (`dropPrivate`) or app exit —
 *   so "delete persisted sessions" legitimately excludes them. (Flushing `mem`
 *   here would be unsafe: a still-live private session's next `appendMessage`
 *   would fall through to `super` and write to disk, breaking the privacy
 *   guarantee.)
 * - This decorator works by overriding every SQLite-backed read/write path. If
 *   the base `Repo` gains a NEW persistence method, add a matching override here
 *   or private sessions will silently leak to disk.
 */
export class PrivacyAwareRepo extends Repo {
  private readonly mem = new Map<string, PrivateEntry>();

  constructor(db: Database) {
    super(db);
  }

  isPrivate(id: string): boolean {
    return this.mem.has(id);
  }

  /** Free the in-memory state for a private session (call on session close). No-op otherwise. */
  dropPrivate(id: string): void {
    this.mem.delete(id);
  }

  createSession(args: CreateSessionArgs): void {
    if (!args.private) {
      super.createSession(args);
      return;
    }
    this.mem.set(args.id, {
      meta: {
        id: args.id,
        title: null,
        createdAt: args.createdAt,
        lastActive: args.lastActive,
        model: args.model,
        status: 'active',
        sdkSessionId: null,
      },
      messages: [],
    });
  }

  setSdkSessionId(ottoSessionId: string, sdkSessionId: string): void {
    const entry = this.mem.get(ottoSessionId);
    if (entry) {
      entry.meta = { ...entry.meta, sdkSessionId };
      return;
    }
    super.setSdkSessionId(ottoSessionId, sdkSessionId);
  }

  setSessionTitleIfMissing(id: string, title: string): void {
    const entry = this.mem.get(id);
    if (entry) {
      if (entry.meta.title == null) entry.meta = { ...entry.meta, title };
      return;
    }
    super.setSessionTitleIfMissing(id, title);
  }

  updateSessionActivity(id: string, lastActive: number, status: SessionMeta['status']): void {
    const entry = this.mem.get(id);
    if (entry) {
      entry.meta = { ...entry.meta, lastActive, status };
      return;
    }
    super.updateSessionActivity(id, lastActive, status);
  }

  getSession(id: string): SessionMeta | null {
    const entry = this.mem.get(id);
    if (entry) return entry.meta;
    return super.getSession(id);
  }

  loadMessages(sessionId: string): Message[] {
    const entry = this.mem.get(sessionId);
    if (entry) return [...entry.messages];
    return super.loadMessages(sessionId);
  }

  appendMessage(m: Message & { sessionId: string }): Message {
    const entry = this.mem.get(m.sessionId);
    if (!entry) return super.appendMessage(m);
    const existingIdx = entry.messages.findIndex((x) => x.id === m.id);
    if (existingIdx >= 0) {
      const seq = entry.messages[existingIdx]!.seq;
      const updated = { ...m, seq } as Message;
      entry.messages[existingIdx] = updated;
      return updated;
    }
    // Mirror the base Repo's MAX(seq)+1 so seq stays correct even if a message
    // is ever removed (array length would collide after a removal).
    const seq = entry.messages.reduce((max, x) => Math.max(max, x.seq), -1) + 1;
    const stored = { ...m, seq } as Message;
    entry.messages.push(stored);
    return stored;
  }
}
