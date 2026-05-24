import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from './db';
import { Repo } from './repo';
import { newUserMessage, newAssistantMessage, newSystemMessage } from '@shared/messages';

let dir: string;
let db: Database;
let repo: Repo;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-repo-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  repo = new Repo(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Repo.sessions', () => {
  it('creates and lists sessions ordered by last_active desc', () => {
    repo.createSession({ id: 's1', model: 'm', createdAt: 1, lastActive: 10 });
    repo.createSession({ id: 's2', model: 'm', createdAt: 2, lastActive: 20 });
    const list = repo.listSessions();
    expect(list.map((s) => s.id)).toEqual(['s2', 's1']);
  });

  it('updates last_active and status', () => {
    repo.createSession({ id: 's1', model: 'm', createdAt: 1, lastActive: 10 });
    repo.updateSessionActivity('s1', 99, 'ended');
    const [s] = repo.listSessions();
    expect(s!.lastActive).toBe(99);
    expect(s!.status).toBe('ended');
  });

  it('persists and reads sdk_session_id', () => {
    repo.createSession({ id: 's1', model: 'm', createdAt: 1, lastActive: 1 });
    expect(repo.getSession('s1')?.sdkSessionId).toBeNull();
    repo.setSdkSessionId('s1', 'sdk-abc');
    expect(repo.getSession('s1')?.sdkSessionId).toBe('sdk-abc');
  });

  it('sets a title once', () => {
    repo.createSession({ id: 's1', model: 'm', createdAt: 1, lastActive: 1 });
    repo.setSessionTitleIfMissing('s1', 'first prompt');
    repo.setSessionTitleIfMissing('s1', 'second prompt');
    const [s] = repo.listSessions();
    expect(s!.title).toBe('first prompt');
  });
});

describe('Repo.messages', () => {
  it('appends messages with monotonically increasing seq within a session', () => {
    repo.createSession({ id: 's1', model: 'm', createdAt: 1, lastActive: 1 });
    const u = { ...newUserMessage('hi'), sessionId: 's1' };
    const a = { ...newAssistantMessage(), sessionId: 's1' };
    repo.appendMessage(u);
    repo.appendMessage(a);
    const loaded = repo.loadMessages('s1');
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.seq).toBe(0);
    expect(loaded[1]!.seq).toBe(1);
    expect(loaded[0]!.role).toBe('user');
    expect(loaded[1]!.role).toBe('assistant');
  });

  it('round-trips content json', () => {
    repo.createSession({ id: 's1', model: 'm', createdAt: 1, lastActive: 1 });
    const a = {
      ...newAssistantMessage(),
      sessionId: 's1',
      content: [
        { type: 'text' as const, text: 'hello' },
        { type: 'tool_use' as const, callId: 'c1', name: 'echo', input: { msg: 'hi' } },
      ],
    };
    repo.appendMessage(a);
    const [loaded] = repo.loadMessages('s1');
    expect(loaded!.content).toEqual(a.content);
  });
});

describe('Repo.messages system role', () => {
  it('round-trips a system message with a memory-update content block', () => {
    repo.createSession({ id: 's1', model: 'm', createdAt: 1, lastActive: 1 });
    const sys = {
      ...newSystemMessage([
        { type: 'memory-update' as const, facts: 1, playbooks: 2, antiPatterns: 0, heuristics: 1 },
      ]),
      sessionId: 's1',
    };
    repo.appendMessage(sys);
    const loaded = repo.loadMessages('s1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.role).toBe('system');
    expect(loaded[0]!.content).toEqual([
      { type: 'memory-update', facts: 1, playbooks: 2, antiPatterns: 0, heuristics: 1 },
    ]);
  });
});
