import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../db/db';
import { FactRepo } from '../db/fact-repo';
import { renderPinnedAsMarkdown, regenerateKnowledgeFile } from './store';
import { createStubEmbedder } from '../embeddings/stub';

let dir: string;
let db: Database;
let repo: FactRepo;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-store-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  repo = new FactRepo(db, undefined, createStubEmbedder());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('renderPinnedAsMarkdown', () => {
  it('returns empty string when no pinned facts', () => {
    expect(renderPinnedAsMarkdown(repo)).toBe('');
  });
  it('lists pinned facts as bullets', async () => {
    await repo.upsert({ body: 'A', pinned: true });
    await repo.upsert({ body: 'B', pinned: true });
    repo.rerank();
    const md = renderPinnedAsMarkdown(repo);
    expect(md).toContain('- A');
    expect(md).toContain('- B');
  });
});

describe('regenerateKnowledgeFile', () => {
  it('writes a knowledge.md projection with auto-generated banner', async () => {
    await repo.upsert({ body: 'A', pinned: true });
    repo.rerank();
    await regenerateKnowledgeFile(dir, repo);
    const txt = readFileSync(path.join(dir, 'knowledge.md'), 'utf8');
    expect(txt).toContain('auto-generated');
    expect(txt).toContain('- A');
  });
  it('writes an empty-state file when nothing pinned', async () => {
    await regenerateKnowledgeFile(dir, repo);
    expect(existsSync(path.join(dir, 'knowledge.md'))).toBe(true);
  });
});
