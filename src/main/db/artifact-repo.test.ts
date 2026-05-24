import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from './db';
import { ArtifactRepo } from './artifact-repo';

let dir: string;
let db: Database;
let repo: ArtifactRepo;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-artrepo-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  repo = new ArtifactRepo(db, () => 1000);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ArtifactRepo', () => {
  it('inserts a new artifact and lists it back', () => {
    const id = repo.upsert({
      kind: 'playbook',
      title: 'Fix audio stutter',
      body: '## Steps\n1. restart pipewire',
      tags: ['audio', 'stutter'],
      sourceSessionId: 's1',
    });
    const all = repo.list({ kind: 'playbook' });
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(id);
    expect(all[0]!.title).toBe('Fix audio stutter');
    expect(all[0]!.tags).toEqual(['audio', 'stutter']);
    expect(all[0]!.useCount).toBe(0);
    expect(all[0]!.archived).toBe(false);
  });

  it('upsert updates existing row when (kind,title) matches case-insensitively', () => {
    const id1 = repo.upsert({
      kind: 'playbook',
      title: 'Fix Audio Stutter',
      body: 'v1',
      tags: ['audio'],
      sourceSessionId: 's1',
    });
    repo.bumpUse(id1);
    expect(repo.get(id1)?.useCount).toBe(1);
    const id2 = repo.upsert({
      kind: 'playbook',
      title: 'fix audio stutter',
      body: 'v2',
      tags: ['audio', 'pipewire'],
      sourceSessionId: 's2',
    });
    expect(id2).toBe(id1);
    const row = repo.get(id1)!;
    expect(row.body).toBe('v2');
    expect(row.tags).toEqual(['audio', 'pipewire']);
    expect(row.useCount).toBe(1); // preserved
  });

  it('search returns FTS hits ordered by rank, excluding archived', () => {
    const a = repo.upsert({
      kind: 'playbook',
      title: 'restart pipewire',
      body: 'systemctl --user restart pipewire',
      tags: ['audio'],
    });
    repo.upsert({
      kind: 'playbook',
      title: 'unrelated thing',
      body: 'nothing here',
      tags: [],
    });
    const archived = repo.upsert({
      kind: 'playbook',
      title: 'old pipewire fix',
      body: 'deprecated',
      tags: [],
    });
    repo.update(archived, { archived: true });

    const hits = repo.search({ query: 'pipewire', limit: 5 });
    expect(hits.map((h) => h.id)).toEqual([a]);
  });

  it('bumpUse increments use_count and sets last_used_at', () => {
    const id = repo.upsert({ kind: 'heuristic', title: 't', body: 'b', tags: [] });
    repo.bumpUse(id);
    repo.bumpUse(id);
    const row = repo.get(id)!;
    expect(row.useCount).toBe(2);
    expect(row.lastUsedAt).toBe(1000);
  });

  it('counts by kind ignore archived', () => {
    repo.upsert({ kind: 'playbook', title: 'p1', body: '', tags: [] });
    repo.upsert({ kind: 'playbook', title: 'p2', body: '', tags: [] });
    const aId = repo.upsert({ kind: 'anti_pattern', title: 'a1', body: '', tags: [] });
    repo.update(aId, { archived: true });
    const c = repo.counts();
    expect(c).toEqual({ playbook: 2, anti_pattern: 0, heuristic: 0 });
  });

  it('sanitizes FTS query operators so user input cannot break MATCH', () => {
    repo.upsert({ kind: 'playbook', title: 'has parens', body: 'body', tags: [] });
    // ')(' would cause an FTS syntax error if not sanitized.
    const hits = repo.search({ query: 'has)( parens', limit: 5 });
    expect(hits).toHaveLength(1);
  });

  it('delete removes the row and its FTS entry', () => {
    const id = repo.upsert({ kind: 'playbook', title: 'goner', body: 'b', tags: [] });
    repo.delete(id);
    expect(repo.get(id)).toBeNull();
    expect(repo.search({ query: 'goner', limit: 5 })).toEqual([]);
  });
});
