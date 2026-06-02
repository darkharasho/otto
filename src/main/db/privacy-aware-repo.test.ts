import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from './db';
import { PrivacyAwareRepo } from './privacy-aware-repo';
import { newUserMessage } from '@shared/messages';

let dir: string;
let db: Database;
let repo: PrivacyAwareRepo;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-priv-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  repo = new PrivacyAwareRepo(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('PrivacyAwareRepo', () => {
  it('keeps private sessions out of the database and out of listSessions', () => {
    repo.createSession({ id: 'p1', model: 'm', createdAt: 1, lastActive: 1, private: true });
    expect(repo.isPrivate('p1')).toBe(true);
    expect(repo.listSessions().find((s) => s.id === 'p1')).toBeUndefined();
    const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get('p1');
    expect(row).toBeUndefined();
    expect(repo.getSession('p1')?.model).toBe('m');
  });

  it('persists non-private sessions to the database as before', () => {
    repo.createSession({ id: 'n1', model: 'm', createdAt: 1, lastActive: 1 });
    expect(repo.isPrivate('n1')).toBe(false);
    const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get('n1') as { id: string };
    expect(row.id).toBe('n1');
    expect(repo.listSessions().find((s) => s.id === 'n1')).toBeDefined();
  });

  it('stores private messages in memory only, with sequential seq', () => {
    repo.createSession({ id: 'p1', model: 'm', createdAt: 1, lastActive: 1, private: true });
    const a = repo.appendMessage({ ...newUserMessage('first'), sessionId: 'p1' });
    const b = repo.appendMessage({ ...newUserMessage('second'), sessionId: 'p1' });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(repo.loadMessages('p1').map((m) => m.id)).toEqual([a.id, b.id]);
    const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get('p1') as { n: number };
    expect(count.n).toBe(0);
  });

  it('records sdk session id and activity for private sessions in memory', () => {
    repo.createSession({ id: 'p1', model: 'm', createdAt: 1, lastActive: 1, private: true });
    repo.setSdkSessionId('p1', 'sdk-xyz');
    repo.updateSessionActivity('p1', 99, 'idle');
    const meta = repo.getSession('p1')!;
    expect(meta.sdkSessionId).toBe('sdk-xyz');
    expect(meta.lastActive).toBe(99);
    expect(meta.status).toBe('idle');
  });

  it('dropPrivate frees the in-memory session', () => {
    repo.createSession({ id: 'p1', model: 'm', createdAt: 1, lastActive: 1, private: true });
    repo.dropPrivate('p1');
    expect(repo.isPrivate('p1')).toBe(false);
    expect(repo.getSession('p1')).toBeNull();
  });
});
