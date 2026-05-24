import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../db/db';
import { ArtifactRepo } from '../db/artifact-repo';
import { Repo } from '../db/repo';
import { ReflectionPipeline } from './pipeline';
import { newAssistantMessage, newUserMessage } from '@shared/messages';
import type { ReflectOutcome } from './reflector';

let dir: string;
let db: Database;
let repo: Repo;
let artifactRepo: ArtifactRepo;
const REFLECTOR_OK = (overrides: Partial<{ facts: string[] }> = {}): ReflectOutcome => ({
  ok: true,
  raw: '{}',
  result: {
    facts: overrides.facts ?? ['Browser is Zen'],
    playbooks: [
      { title: 'Restart audio', body: '## Steps\n1. restart pipewire', tags: ['audio'] },
    ],
    antiPatterns: [],
    heuristics: [],
  },
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-pipe-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  repo = new Repo(db);
  artifactRepo = new ArtifactRepo(db, () => 1000);
  repo.createSession({ id: 's1', model: 'm', createdAt: 0, lastActive: 0 });
  repo.appendMessage({ ...newUserMessage('please fix audio'), sessionId: 's1' });
  repo.appendMessage({ ...newAssistantMessage(), sessionId: 's1' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ReflectionPipeline.run', () => {
  it('appends facts to knowledge.md and inserts new artifacts', async () => {
    const appendSystemNote = vi.fn();
    const pipeline = new ReflectionPipeline({
      repo,
      artifactRepo,
      configDir: dir,
      runReflector: async () => REFLECTOR_OK(),
      appendSystemNote,
    });
    const out = await pipeline.run({ sessionId: 's1', sinceSeq: -1 });
    expect(out.savedFacts).toBe(1);
    expect(out.savedArtifacts).toBe(1);
    const knowledge = readFileSync(path.join(dir, 'knowledge.md'), 'utf8');
    expect(knowledge).toContain('Browser is Zen');
    expect(artifactRepo.list({ kind: 'playbook' })).toHaveLength(1);
    expect(appendSystemNote).toHaveBeenCalledWith('s1', {
      type: 'memory-update',
      facts: 1,
      playbooks: 1,
      antiPatterns: 0,
      heuristics: 0,
    });
  });

  it('does not notify when reflector returns nothing', async () => {
    const appendSystemNote = vi.fn();
    const pipeline = new ReflectionPipeline({
      repo,
      artifactRepo,
      configDir: dir,
      runReflector: async () => ({
        ok: true,
        raw: '{}',
        result: { facts: [], playbooks: [], antiPatterns: [], heuristics: [], skip_reason: 'trivial' },
      }),
      appendSystemNote,
    });
    const out = await pipeline.run({ sessionId: 's1', sinceSeq: -1 });
    expect(out.savedFacts).toBe(0);
    expect(out.savedArtifacts).toBe(0);
    expect(appendSystemNote).not.toHaveBeenCalled();
  });

  it('silently drops on reflector failure', async () => {
    const pipeline = new ReflectionPipeline({
      repo,
      artifactRepo,
      configDir: dir,
      runReflector: async () => ({ ok: false, reason: 'parse-error', raw: 'junk' }),
      appendSystemNote: vi.fn(),
    });
    const out = await pipeline.run({ sessionId: 's1', sinceSeq: -1 });
    expect(out.savedFacts).toBe(0);
    expect(out.savedArtifacts).toBe(0);
  });

  it('skips a fact whose normalized form already lives in knowledge.md', async () => {
    const pipeline = new ReflectionPipeline({
      repo,
      artifactRepo,
      configDir: dir,
      runReflector: async () => REFLECTOR_OK({ facts: ['Browser is Zen', 'Browser is Zen'] }),
      appendSystemNote: () => {},
    });
    await pipeline.run({ sessionId: 's1', sinceSeq: -1 });
    await pipeline.run({ sessionId: 's1', sinceSeq: -1 }); // run twice
    const knowledge = readFileSync(path.join(dir, 'knowledge.md'), 'utf8');
    const occurrences = knowledge.split('Browser is Zen').length - 1;
    expect(occurrences).toBe(1);
  });

  it('refuses to insert new artifacts once a kind hits the 500 hard cap', async () => {
    for (let i = 0; i < 500; i += 1) {
      artifactRepo.upsert({ kind: 'playbook', title: `pb-${i}`, body: 'b', tags: [] });
    }
    const pipeline = new ReflectionPipeline({
      repo,
      artifactRepo,
      configDir: dir,
      runReflector: async () => REFLECTOR_OK({ facts: [] }),
      appendSystemNote: vi.fn(),
    });
    const out = await pipeline.run({ sessionId: 's1', sinceSeq: -1 });
    expect(out.savedArtifacts).toBe(0);
    expect(out.capReached).toContain('playbook');
  });
});
