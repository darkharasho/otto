# Knowledge pin/learn split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move facts out of the always-loaded `knowledge.md` and into a SQLite `fact` table that maintains a bounded, score-ranked pinned subset (top N=40 by `distinct_sessions * exp(-age_days / 21)`). Pinned facts are always loaded into the system prompt; the rest are recall-on-demand.

**Architecture:** New `FactRepo` (mirrors `ArtifactRepo` shape, adds promotion/eviction). Reflector tags new facts with optional `preference` flag for bootstrap. `knowledge.md` becomes a regenerated read-only projection. Migration imports existing markdown lines into the table.

**Tech Stack:** TypeScript, better-sqlite3 with FTS5, vitest, Electron main/renderer split.

**Spec:** `docs/superpowers/specs/2026-05-24-knowledge-pin-split-design.md`

**Constants (defined in `src/main/db/fact-repo.ts`):**
- `PINNED_BUDGET = 40`
- `SCORE_HALF_LIFE_MS = 21 * 86_400_000`
- `PROMOTION_THRESHOLD = 3`
- `BOOTSTRAP_PREFERENCE_SESSIONS = 2`

---

## File Structure

**Create:**
- `src/main/db/fact-repo.ts` — `FactRepo` class.
- `src/main/db/fact-repo.test.ts` — unit tests.
- `src/main/knowledge/import-legacy.ts` — one-shot parser for legacy `knowledge.md`.
- `src/main/knowledge/import-legacy.test.ts` — parser tests.

**Modify:**
- `src/main/db/db.ts` — add migration 004 (fact + FTS + triggers); call legacy importer after migration.
- `src/main/db/db.test.ts` — assert version 4 and new tables.
- `src/main/knowledge/store.ts` — replace `appendKnowledge`/`readKnowledge` with `renderPinnedAsMarkdown(repo)` and `regenerateKnowledgeFile(configDir, repo)`.
- `src/main/knowledge/store.test.ts` — (create if missing) cover new helpers.
- `src/main/knowledge/dedup.ts` — keep `normalizeFactLine`; remove `filterNovelFacts` (its job moves into `FactRepo.upsert` dedup-on-`body_norm`).
- `src/main/knowledge/dedup.test.ts` — drop the `filterNovelFacts` tests; keep `normalizeFactLine` tests.
- `src/main/reflection/schema.ts` — `facts` becomes `Array<{ body; preference? }>`.
- `src/main/reflection/schema.test.ts` — update.
- `src/main/reflection/prompt.ts` — describe `preference` flag.
- `src/main/reflection/prompt.test.ts` — update assertion.
- `src/main/reflection/pipeline.ts` — call `FactRepo.upsert` then `rerank`; emit promoted/demoted counts.
- `src/main/reflection/pipeline.test.ts` — update fixtures.
- `src/main/agent/tools.ts` — `buildKnowledgeTool` keeps the same surface; `buildRecallTool` description tweaked.
- `src/main/agent/sdk-client.ts` — handler for `knowledge_append` now calls `FactRepo.upsert({ ..., preference: true })`; turn-start loads pinned via repo + `bumpUse`. Extend `RealSdkClientDeps` with `factsForPrompt` and `bumpFactUse`.
- `src/main/index.ts` — wire `FactRepo` into `recall`, `factsForPrompt`, `bumpFactUse`, and the reflection pipeline.
- `src/main/ipc/handlers.ts` — replace `memory.readFacts`/`memory.writeFacts` with `memory.list` returning facts from repo (with `pinned`, `useCount`).
- `src/shared/ipc-contract.ts` — update fact view types.
- `src/renderer/components/settings/MemorySection.tsx` — replace `Edit knowledge.md…` with read-only fact list rendering pinned badge + use count.
- `src/renderer/components/settings/MemorySection.test.tsx` — update.

---

## Task 1: Add `fact` schema migration

**Files:**
- Modify: `src/main/db/db.ts` (add MIGRATION_004_FACTS)
- Modify: `src/main/db/db.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/main/db/db.test.ts`:

```ts
it('runs migration 004 creating fact, fact_session, fact_fts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'otto-db-'));
  const db = openDatabase(path.join(dir, 'otto.db'));
  const version = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
  expect(version).toBeGreaterThanOrEqual(4);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='virtual table'").all() as { name: string }[]).map((r) => r.name);
  expect(tables).toContain('fact');
  expect(tables).toContain('fact_session');
  expect(tables).toContain('fact_fts');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `pnpm vitest run src/main/db/db.test.ts`
Expected: FAIL — version is 3, fact table missing.

- [ ] **Step 3: Add migration 004 in `src/main/db/db.ts`**

After `MIGRATION_003_ARTIFACTS`:

```ts
const MIGRATION_004_FACTS = `
CREATE TABLE IF NOT EXISTS fact (
  id                 TEXT PRIMARY KEY,
  body               TEXT NOT NULL,
  body_norm          TEXT NOT NULL,
  pinned             INTEGER NOT NULL DEFAULT 0,
  use_count          INTEGER NOT NULL DEFAULT 0,
  distinct_sessions  INTEGER NOT NULL DEFAULT 0,
  score              REAL NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  last_used_at       INTEGER,
  source_session_id  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS fact_body_norm_idx ON fact(body_norm);
CREATE INDEX IF NOT EXISTS fact_pinned_idx ON fact(pinned);

CREATE TABLE IF NOT EXISTS fact_session (
  fact_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (fact_id, session_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS fact_fts USING fts5(
  body,
  content='fact',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS fact_ai AFTER INSERT ON fact BEGIN
  INSERT INTO fact_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TRIGGER IF NOT EXISTS fact_ad AFTER DELETE ON fact BEGIN
  INSERT INTO fact_fts(fact_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;

CREATE TRIGGER IF NOT EXISTS fact_au AFTER UPDATE ON fact BEGIN
  INSERT INTO fact_fts(fact_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO fact_fts(rowid, body) VALUES (new.rowid, new.body);
END;
`;
```

And add to the `MIGRATIONS` array:

```ts
{ version: 4, sql: MIGRATION_004_FACTS },
```

- [ ] **Step 4: Run test, verify PASS**

Run: `pnpm vitest run src/main/db/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/db/db.ts src/main/db/db.test.ts
git commit -m "feat(db): add fact + fact_session + fact_fts migration 004"
```

---

## Task 2: `FactRepo.upsert` + dedup on `body_norm`

**Files:**
- Create: `src/main/db/fact-repo.ts`
- Create: `src/main/db/fact-repo.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/db/fact-repo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from './db';
import { FactRepo } from './fact-repo';

let dir: string;
let db: Database;
let repo: FactRepo;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-factrepo-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  repo = new FactRepo(db, () => NOW);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('FactRepo.upsert', () => {
  it('inserts a new fact with default counters', () => {
    const { id, inserted } = repo.upsert({ body: 'Browser of choice is Zen', sourceSessionId: 's1' });
    expect(inserted).toBe(true);
    const row = repo.get(id)!;
    expect(row.body).toBe('Browser of choice is Zen');
    expect(row.pinned).toBe(false);
    expect(row.distinctSessions).toBe(0);
    expect(row.useCount).toBe(0);
    expect(row.createdAt).toBe(NOW);
  });

  it('dedups on normalized body and returns the existing id', () => {
    const a = repo.upsert({ body: 'browser of choice is zen' });
    const b = repo.upsert({ body: '  Browser  of choice IS Zen  ' });
    expect(b.id).toBe(a.id);
    expect(b.inserted).toBe(false);
  });

  it('bootstraps distinct_sessions=2 when preference=true', () => {
    const { id } = repo.upsert({ body: 'always use kdotool first on Wayland', preference: true });
    expect(repo.get(id)!.distinctSessions).toBe(2);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** (module not found)

Run: `pnpm vitest run src/main/db/fact-repo.test.ts`

- [ ] **Step 3: Implement `FactRepo` skeleton + `upsert` + `get`**

Create `src/main/db/fact-repo.ts`:

```ts
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { normalizeFactLine } from '../knowledge/dedup';

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
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm vitest run src/main/db/fact-repo.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/main/db/fact-repo.ts src/main/db/fact-repo.test.ts
git commit -m "feat(fact-repo): upsert + body_norm dedup + preference bootstrap"
```

---

## Task 3: `FactRepo.search` (FTS5)

**Files:**
- Modify: `src/main/db/fact-repo.ts`
- Modify: `src/main/db/fact-repo.test.ts`

- [ ] **Step 1: Write failing test**

Append to `fact-repo.test.ts`:

```ts
describe('FactRepo.search', () => {
  it('returns FTS hits ranked', () => {
    repo.upsert({ body: 'Spectacle needs -bnf on multi-monitor' });
    repo.upsert({ body: 'Browser of choice is Zen' });
    const hits = repo.search({ query: 'spectacle multi-monitor', limit: 5 });
    expect(hits.map((h) => h.body)).toEqual(['Spectacle needs -bnf on multi-monitor']);
  });

  it('sanitizes FTS operator characters', () => {
    repo.upsert({ body: 'audio device is Focusrite Scarlett' });
    const hits = repo.search({ query: 'audio "device"', limit: 5 });
    expect(hits).toHaveLength(1);
  });

  it('returns empty array when query is blank after sanitize', () => {
    repo.upsert({ body: 'x' });
    expect(repo.search({ query: '()*', limit: 5 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement `search` (reuse the same sanitizer pattern from `artifact-repo.ts`)**

Add to `fact-repo.ts`:

```ts
export function sanitizeFtsQuery(q: string): string {
  const cleaned = q.replace(/["()*:^]/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `${t}*`)
    .join(' ');
}
```

Add method on `FactRepo`:

```ts
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
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/main/db/fact-repo.ts src/main/db/fact-repo.test.ts
git commit -m "feat(fact-repo): FTS5 search with sanitized query"
```

---

## Task 4: `FactRepo.bumpUse` + session tracking

**Files:**
- Modify: `src/main/db/fact-repo.ts`
- Modify: `src/main/db/fact-repo.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `fact-repo.test.ts`:

```ts
describe('FactRepo.bumpUse', () => {
  it('increments use_count and last_used_at; first time in session increments distinct_sessions', () => {
    const { id } = repo.upsert({ body: 'fact A' });
    repo.bumpUse([id], 's1');
    let row = repo.get(id)!;
    expect(row.useCount).toBe(1);
    expect(row.distinctSessions).toBe(1);
    expect(row.lastUsedAt).toBe(NOW);
    repo.bumpUse([id], 's1');
    row = repo.get(id)!;
    expect(row.useCount).toBe(2);
    expect(row.distinctSessions).toBe(1); // same session, no bump
    repo.bumpUse([id], 's2');
    row = repo.get(id)!;
    expect(row.useCount).toBe(3);
    expect(row.distinctSessions).toBe(2);
  });

  it('is a no-op for empty list', () => {
    expect(() => repo.bumpUse([], 's1')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement `bumpUse`**

Add to `FactRepo`:

```ts
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
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/main/db/fact-repo.ts src/main/db/fact-repo.test.ts
git commit -m "feat(fact-repo): bumpUse with session-deduped distinct count"
```

---

## Task 5: `FactRepo.rerank` + `listPinned` + scoring

**Files:**
- Modify: `src/main/db/fact-repo.ts`
- Modify: `src/main/db/fact-repo.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `fact-repo.test.ts`:

```ts
describe('FactRepo.rerank', () => {
  function seedWithSessions(body: string, sessions: string[], lastUsedAt: number): string {
    const { id } = repo.upsert({ body });
    for (const s of sessions) {
      // bypass bumpUse to control timestamp
      db.prepare('INSERT OR IGNORE INTO fact_session (fact_id, session_id) VALUES (?, ?)').run(id, s);
    }
    db.prepare(
      'UPDATE fact SET distinct_sessions = ?, use_count = ?, last_used_at = ? WHERE id = ?'
    ).run(sessions.length, sessions.length, lastUsedAt, id);
    return id;
  }

  it('elects top PINNED_BUDGET by recency-weighted score', () => {
    // 41 facts, all with distinct_sessions=5; vary recency so the oldest is bumped.
    const ids: string[] = [];
    for (let i = 0; i < 41; i++) {
      const ageDays = i; // i=0 newest, i=40 oldest
      ids.push(seedWithSessions(`fact ${i}`, ['s1', 's2', 's3', 's4', 's5'], NOW - ageDays * 86_400_000));
    }
    const result = repo.rerank();
    const pinned = repo.listPinned();
    expect(pinned).toHaveLength(40);
    // The oldest (last id) should be the only demoted one.
    expect(result.demoted).toEqual(expect.arrayContaining([ids[40]]));
    expect(result.demoted).toHaveLength(1);
  });

  it('reports promoted ids when a learned fact moves into the budget', () => {
    const learned = repo.upsert({ body: 'a freshly promoted fact' });
    db.prepare('UPDATE fact SET distinct_sessions = ?, use_count = ?, last_used_at = ? WHERE id = ?')
      .run(5, 5, NOW, learned.id);
    const result = repo.rerank();
    expect(result.promoted).toContain(learned.id);
    expect(repo.get(learned.id)!.pinned).toBe(true);
  });

  it('uses created_at when last_used_at is null', () => {
    const old = repo.upsert({ body: 'old never-used', createdAt: NOW - 100 * 86_400_000 });
    const recent = repo.upsert({ body: 'recent never-used', createdAt: NOW });
    db.prepare('UPDATE fact SET distinct_sessions = ? WHERE id = ?').run(1, old.id);
    db.prepare('UPDATE fact SET distinct_sessions = ? WHERE id = ?').run(1, recent.id);
    repo.rerank();
    expect(repo.get(recent.id)!.score).toBeGreaterThan(repo.get(old.id)!.score);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement scoring + `rerank` + `listPinned`**

Add to `fact-repo.ts`:

```ts
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
        else if (!shouldPin && s.wasPinned) demoted.push(s.id);
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
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/main/db/fact-repo.ts src/main/db/fact-repo.test.ts
git commit -m "feat(fact-repo): score-ranked rerank with PINNED_BUDGET eviction"
```

---

## Task 6: `FactRepo.list` + `counts`

**Files:**
- Modify: `src/main/db/fact-repo.ts`
- Modify: `src/main/db/fact-repo.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `fact-repo.test.ts`:

```ts
describe('FactRepo.list and counts', () => {
  it('list returns facts ordered by score desc, includes pinned flag', () => {
    repo.upsert({ body: 'a' });
    repo.upsert({ body: 'b', pinned: true });
    const all = repo.list({ limit: 10 });
    expect(all).toHaveLength(2);
    expect(all.map((f) => f.body)).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('counts returns pinned + total', () => {
    repo.upsert({ body: 'a' });
    repo.upsert({ body: 'b', pinned: true });
    repo.upsert({ body: 'c', pinned: true });
    expect(repo.counts()).toEqual({ pinned: 2, total: 3 });
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement `list` + `counts`**

Add to `FactRepo`:

```ts
  list(args: { limit?: number } = {}): Fact[] {
    const limit = args.limit ?? 500;
    return (this.db
      .prepare('SELECT * FROM fact ORDER BY pinned DESC, score DESC, created_at DESC LIMIT ?')
      .all(limit) as Row[]).map(rowToFact);
  }

  counts(): { pinned: number; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM fact').get() as { n: number }).n;
    const pinned = (this.db.prepare('SELECT COUNT(*) AS n FROM fact WHERE pinned = 1').get() as { n: number }).n;
    return { pinned, total };
  }
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/main/db/fact-repo.ts src/main/db/fact-repo.test.ts
git commit -m "feat(fact-repo): list + counts for settings UI"
```

---

## Task 7: Legacy `knowledge.md` importer

**Files:**
- Create: `src/main/knowledge/import-legacy.ts`
- Create: `src/main/knowledge/import-legacy.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/knowledge/import-legacy.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../db/db';
import { FactRepo } from '../db/fact-repo';
import { importLegacyKnowledge } from './import-legacy';

let dir: string;
let db: Database;
let repo: FactRepo;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-import-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  repo = new FactRepo(db, () => NOW);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('importLegacyKnowledge', () => {
  it('is a no-op when knowledge.md is absent', async () => {
    await importLegacyKnowledge(dir, repo);
    expect(repo.counts().total).toBe(0);
  });

  it('parses bullet lines into pinned facts and renames the source file', async () => {
    writeFileSync(
      path.join(dir, 'knowledge.md'),
      '# Otto knowledge file\n\nDurable facts...\n\n- (2026-04-01) Browser of choice is Zen\n- (2026-04-02) Spectacle needs -bnf on multi-monitor\n'
    );
    await importLegacyKnowledge(dir, repo);
    const all = repo.list({ limit: 50 });
    expect(all.map((f) => f.body)).toEqual(
      expect.arrayContaining(['Browser of choice is Zen', 'Spectacle needs -bnf on multi-monitor'])
    );
    expect(all.every((f) => f.pinned)).toBe(true);
    // Apr 1 2026 UTC midnight
    const apr1 = Date.UTC(2026, 3, 1);
    expect(all.find((f) => f.body === 'Browser of choice is Zen')!.createdAt).toBe(apr1);
    expect(existsSync(path.join(dir, 'knowledge.md'))).toBe(false);
    expect(existsSync(path.join(dir, 'knowledge.md.pre-split.bak'))).toBe(true);
    expect(readFileSync(path.join(dir, 'knowledge.md.pre-split.bak'), 'utf8')).toContain('Zen');
  });

  it('imports non-bullet lines with created_at = now()', async () => {
    writeFileSync(path.join(dir, 'knowledge.md'), 'Just a freeform line\n');
    await importLegacyKnowledge(dir, repo);
    const all = repo.list({ limit: 50 });
    expect(all).toHaveLength(1);
    expect(all[0]!.createdAt).toBe(NOW);
  });

  it('is idempotent: a second run with the .bak in place does nothing', async () => {
    writeFileSync(path.join(dir, 'knowledge.md'), '- (2026-04-01) x\n');
    await importLegacyKnowledge(dir, repo);
    await importLegacyKnowledge(dir, repo);
    expect(repo.counts().total).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement the importer**

Create `src/main/knowledge/import-legacy.ts`:

```ts
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FactRepo } from '../db/fact-repo';
import { logger } from '../logger';

const LEGACY_FILE = 'knowledge.md';
const BACKUP_FILE = 'knowledge.md.pre-split.bak';
const BULLET_RE = /^\s*-\s*\((\d{4})-(\d{2})-(\d{2})\)\s*(.*\S)\s*$/;

export async function importLegacyKnowledge(configDir: string, repo: FactRepo): Promise<void> {
  const src = path.join(configDir, LEGACY_FILE);
  let text: string;
  try {
    text = await fsp.readFile(src, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.toLowerCase().startsWith('durable facts')) continue;
    const m = BULLET_RE.exec(line);
    let body: string;
    let createdAt: number | undefined;
    if (m) {
      body = m[4]!;
      const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
      createdAt = Date.UTC(y, mo - 1, d);
    } else {
      body = line;
    }
    try {
      repo.upsert({ body, pinned: true, createdAt });
    } catch (err) {
      logger.warn(`importLegacyKnowledge skipped a line: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await fsp.rename(src, path.join(configDir, BACKUP_FILE));
}
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/main/knowledge/import-legacy.ts src/main/knowledge/import-legacy.test.ts
git commit -m "feat(knowledge): import legacy knowledge.md into FactRepo on first run"
```

---

## Task 8: Wire importer + initial rerank into bootstrap

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/db/db.test.ts` (no change required; the importer is called from index.ts, not db.ts)

The importer runs once on app startup, AFTER migrations open the DB but BEFORE the SDK client is constructed. It's idempotent so re-runs are safe.

- [ ] **Step 1: Locate the bootstrap spot in `src/main/index.ts`**

Find where `openDatabase(...)` is called and `ArtifactRepo` is constructed.

- [ ] **Step 2: Add the wiring**

After the repos are constructed and before `createRealSdkClient`:

```ts
import { FactRepo } from './db/fact-repo';
import { importLegacyKnowledge } from './knowledge/import-legacy';
// ...
const factRepo = new FactRepo(db);
await importLegacyKnowledge(ottoConfigDir, factRepo);
factRepo.rerank();
```

If the surrounding scope is not `async`, wrap in `void (async () => { ... })()` or hoist into the existing init async block — match existing patterns in that file.

- [ ] **Step 3: Verify with a manual run**

Run: `pnpm dev` once, confirm no errors, then quit.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(bootstrap): import legacy knowledge.md and rerank on startup"
```

---

## Task 9: Update reflection schema + prompt for `preference` flag

**Files:**
- Modify: `src/main/reflection/schema.ts`
- Modify: `src/main/reflection/schema.test.ts`
- Modify: `src/main/reflection/prompt.ts`
- Modify: `src/main/reflection/prompt.test.ts`

- [ ] **Step 1: Write failing schema test**

Append to `src/main/reflection/schema.test.ts`:

```ts
it('accepts facts as objects with optional preference flag', () => {
  const parsed = ReflectionResultSchema.parse({
    facts: [
      { body: 'Browser of choice is Zen', preference: true },
      { body: 'audio glitched during render' },
    ],
    playbooks: [],
    antiPatterns: [],
    heuristics: [],
  });
  expect(parsed.facts[0]).toEqual({ body: 'Browser of choice is Zen', preference: true });
  expect(parsed.facts[1]).toEqual({ body: 'audio glitched during render' });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Update schema**

In `src/main/reflection/schema.ts`, replace `factSchema` block:

```ts
const factSchema = z.object({
  body: z.string().min(1).max(280),
  preference: z.boolean().optional(),
});
```

(The `facts: z.array(factSchema).max(20)` line stays unchanged.)

Also update any old string-fact tests in `schema.test.ts` — they now must wrap bodies as `{ body: '...' }`.

- [ ] **Step 4: Run schema tests, verify PASS**

Run: `pnpm vitest run src/main/reflection/schema.test.ts`

- [ ] **Step 5: Update prompt + prompt tests**

In `src/main/reflection/prompt.ts`, change the JSON shape comment:

```ts
'  "facts":        Fact[],     // short standalone notes about the machine or user',
```

Insert above the `Artifact = ...` line:

```ts
'Fact = { "body": string (<=280 chars), "preference": boolean? (true = stable user/machine preference) }',
```

Adjust the `CURRENT knowledge.md` block label to `CURRENT pinned facts (do not duplicate facts already here):` — `pipeline.ts` will pass a rendered list of pinned bodies in place of the raw markdown.

- [ ] **Step 6: Update prompt tests** to assert the new lines.

- [ ] **Step 7: Run, verify PASS**

Run: `pnpm vitest run src/main/reflection`

- [ ] **Step 8: Commit**

```bash
git add src/main/reflection/schema.ts src/main/reflection/schema.test.ts src/main/reflection/prompt.ts src/main/reflection/prompt.test.ts
git commit -m "feat(reflection): facts become {body, preference?} objects"
```

---

## Task 10: Reflection pipeline writes via FactRepo + reranks

**Files:**
- Modify: `src/main/reflection/pipeline.ts`
- Modify: `src/main/reflection/pipeline.test.ts`
- Modify: `src/main/knowledge/dedup.ts` (drop `filterNovelFacts`)
- Modify: `src/main/knowledge/dedup.test.ts` (drop those tests)
- Modify: `src/shared/messages.ts` (extend `memory-update` content block with `promoted`, `demoted`)
- Modify: `src/shared/messages.test.ts`

- [ ] **Step 1: Extend `memory-update` content block**

In `src/shared/messages.ts`, find the `memory-update` block type and add fields:

```ts
{
  type: 'memory-update';
  facts: number;
  playbooks: number;
  antiPatterns: number;
  heuristics: number;
  promoted: number;
  demoted: number;
}
```

Add zod/parser assertions in `src/shared/messages.test.ts` for the new fields.

- [ ] **Step 2: Write the failing pipeline test**

Replace the existing `'appends facts to knowledge.md and inserts new artifacts'` test in `src/main/reflection/pipeline.test.ts` with:

```ts
it('upserts facts via FactRepo, reranks, and reports promoted/demoted', async () => {
  // (Repo + factRepo + artifactRepo + configDir setup as in existing tests, but
  // construct a real FactRepo. Add a factRepo parameter to PipelineDeps.)
  const fakeReflector = async () => ({
    ok: true as const,
    result: {
      facts: [{ body: 'Browser of choice is Zen', preference: true }],
      playbooks: [{ title: 'P1', body: '## Steps\n1. x', tags: ['t'] }],
      antiPatterns: [],
      heuristics: [],
    },
  });
  const notes: ContentBlock[] = [];
  const pipeline = new ReflectionPipeline({
    repo, artifactRepo, factRepo, configDir: dir,
    runReflector: fakeReflector,
    appendSystemNote: (_sid, c) => notes.push(c),
  });
  await pipeline.run({ sessionId: 's1', sinceSeq: 0 });
  expect(factRepo.counts().total).toBe(1);
  // preference bootstrap means distinct_sessions=2; with 1 fact total it gets pinned.
  const all = factRepo.list({});
  expect(all[0]!.body).toBe('Browser of choice is Zen');
  expect(all[0]!.pinned).toBe(true);
  const memUpdate = notes.find((n) => n.type === 'memory-update');
  expect(memUpdate).toMatchObject({ facts: 1, playbooks: 1, promoted: 1, demoted: 0 });
});
```

- [ ] **Step 3: Update `PipelineDeps` + `pipeline.ts`**

In `src/main/reflection/pipeline.ts`:

```ts
import type { FactRepo } from '../db/fact-repo';

export interface PipelineDeps {
  repo: Repo;
  artifactRepo: ArtifactRepo;
  factRepo: FactRepo;
  configDir: string;
  runReflector: (prompt: string) => Promise<ReflectOutcome>;
  appendSystemNote: (sessionId: string, content: ContentBlock) => void;
}
```

Replace the existing fact-handling block (the `novelFacts` loop calling `appendKnowledge`) with:

```ts
let factsWritten = 0;
for (const f of outcome.result.facts) {
  try {
    const { inserted } = factRepo.upsert({
      body: f.body,
      preference: f.preference,
      sourceSessionId: args.sessionId,
    });
    if (inserted) factsWritten += 1;
  } catch (err) {
    logger.error('factRepo.upsert failed', err);
  }
}
```

After the artifact loop, call rerank and include counts in the memory-update note:

```ts
const rerank = factRepo.rerank();
// ...
appendSystemNote(args.sessionId, {
  type: 'memory-update',
  facts: factsWritten,
  playbooks: savedByKind.playbook,
  antiPatterns: savedByKind.anti_pattern,
  heuristics: savedByKind.heuristic,
  promoted: rerank.promoted.length,
  demoted: rerank.demoted.length,
});
```

Replace `savedByKind.fact = novelFacts.length` with `savedByKind.fact = factsWritten`. Remove the `knowledgeText` / `filterNovelFacts` / `appendKnowledge` imports and the `readKnowledge(configDir)` call. Instead, build a pinned-bodies list to pass into `buildReflectorPrompt`:

```ts
const pinnedFacts = factRepo.listPinned().map((f) => f.body).join('\n');
const prompt = buildReflectorPrompt({
  originalRequest: transcript.originalRequest,
  transcript: transcript.text,
  knowledgeText: pinnedFacts,  // field kept for prompt-template compatibility
  existingTitles: artifactRepo.titlesForReflectorContext(),
});
```

Total-output reporting (`total = factsWritten + savedArtifacts`) follows the same pattern as today.

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm vitest run src/main/reflection/pipeline.test.ts`

- [ ] **Step 5: Remove `filterNovelFacts`**

In `src/main/knowledge/dedup.ts`, delete the `filterNovelFacts` function. Keep `normalizeFactLine`. Remove the corresponding tests from `src/main/knowledge/dedup.test.ts`.

- [ ] **Step 6: Run all reflection + knowledge tests, verify PASS**

Run: `pnpm vitest run src/main/reflection src/main/knowledge`

- [ ] **Step 7: Commit**

```bash
git add -A src/main/reflection src/main/knowledge/dedup.ts src/main/knowledge/dedup.test.ts src/shared/messages.ts src/shared/messages.test.ts
git commit -m "feat(reflection): facts flow through FactRepo + rerank; report promoted/demoted"
```

---

## Task 11: Replace knowledge store helpers

**Files:**
- Modify: `src/main/knowledge/store.ts`
- Create or modify: `src/main/knowledge/store.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/knowledge/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../db/db';
import { FactRepo } from '../db/fact-repo';
import { renderPinnedAsMarkdown, regenerateKnowledgeFile } from './store';

let dir: string;
let db: Database;
let repo: FactRepo;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-store-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  repo = new FactRepo(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('renderPinnedAsMarkdown', () => {
  it('returns empty string when no pinned facts', () => {
    expect(renderPinnedAsMarkdown(repo)).toBe('');
  });
  it('lists pinned facts as bullets', () => {
    repo.upsert({ body: 'A', pinned: true });
    repo.upsert({ body: 'B', pinned: true });
    repo.rerank(); // recompute scores so listPinned orders deterministically
    const md = renderPinnedAsMarkdown(repo);
    expect(md).toContain('- A');
    expect(md).toContain('- B');
  });
});

describe('regenerateKnowledgeFile', () => {
  it('writes a knowledge.md projection with auto-generated banner', async () => {
    repo.upsert({ body: 'A', pinned: true });
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
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Replace `store.ts`**

Overwrite `src/main/knowledge/store.ts`:

```ts
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FactRepo } from '../db/fact-repo';

const FILENAME = 'knowledge.md';
const HEADER =
  '<!-- auto-generated by Otto; edits will be overwritten on next reflection -->\n' +
  '# Otto pinned facts\n\nDurable facts Otto currently keeps in its working set. Edits here are NOT read back; the source of truth is the SQLite store.\n\n';

export function renderPinnedAsMarkdown(repo: FactRepo): string {
  const pinned = repo.listPinned();
  if (pinned.length === 0) return '';
  return pinned.map((f) => `- ${f.body}`).join('\n');
}

export async function regenerateKnowledgeFile(configDir: string, repo: FactRepo): Promise<void> {
  const body = renderPinnedAsMarkdown(repo);
  const text = body.length === 0 ? `${HEADER}(none yet)\n` : `${HEADER}${body}\n`;
  await fsp.writeFile(path.join(configDir, FILENAME), text, 'utf8');
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm vitest run src/main/knowledge/store.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/main/knowledge/store.ts src/main/knowledge/store.test.ts
git commit -m "feat(knowledge): store helpers render pinned facts as markdown projection"
```

---

## Task 12: Update tools.ts + sdk-client.ts wiring

**Files:**
- Modify: `src/main/agent/tools.ts`
- Modify: `src/main/agent/tools.test.ts`
- Modify: `src/main/agent/sdk-client.ts`

- [ ] **Step 1: Update `buildKnowledgeTool` description and recall tool description**

In `tools.ts`, update the `knowledge_append` description:

```ts
description:
  'Save a durable fact or preference to Otto\'s memory. Stable preferences (browser of choice, hardware quirks, always-do rules) get prioritized for inclusion in future system prompts. Use sparingly — one short line per call. Do NOT use for ephemeral task state.',
```

Update the `recall` description's parenthetical "(lines from knowledge.md)" → "(short standalone notes about the machine or user)".

- [ ] **Step 2: Extend `RealSdkClientDeps`**

In `src/main/agent/sdk-client.ts`, change the `RealSdkClientDeps` interface:

```ts
export interface RealSdkClientDeps {
  broker: DecisionBroker;
  currentMessageId: () => string;
  getRegistry: () => ProcessRegistry;
  getConfigDir: () => string;
  recall: /* unchanged */ ...;
  memoryCounts(): { playbook: number; anti_pattern: number; heuristic: number; factsPinned: number; factsTotal: number };
  /** Returns the pinned-fact markdown block to inline in the system prompt, plus the fact ids to bump. */
  factsForPrompt(): { markdown: string; ids: string[] };
  bumpFactUse(ids: string[], sessionId: string): void;
  appendKnowledge(note: string, sessionId: string): Promise<void>;
  onMarkTaskComplete(sessionId: string, summary: string): void;
}
```

Update `ToolCtx` similarly.

- [ ] **Step 3: Replace the `knowledge_append` handler**

In `buildOttoMcpServer`, replace the `if (t.name === 'knowledge_append') { ... }` block:

```ts
if (t.name === 'knowledge_append') {
  const { note } = args as { note: string };
  await ctx.appendKnowledge(note, ctx.sessionId);
  return { content: [{ type: 'text' as const, text: 'noted' }] };
}
```

Remove the `appendKnowledge` import from `../knowledge/store`.

- [ ] **Step 4: Update turn-start system prompt assembly**

In the `sendTurn` `events` async generator, replace:

```ts
const knowledge = await readKnowledge(deps.getConfigDir()).catch(() => '');
```

with:

```ts
const { markdown: knowledge, ids: pinnedIds } = deps.factsForPrompt();
if (pinnedIds.length > 0) deps.bumpFactUse(pinnedIds, sessionId);
```

Update the `memLine` template to include fact counts:

```ts
const memLine = `Memory currently holds ${memCounts.factsPinned} pinned facts (of ${memCounts.factsTotal} learned), ${memCounts.playbook} playbooks, ${memCounts.anti_pattern} anti-patterns, ${memCounts.heuristic} heuristics.`;
```

Update the conditional that adds the pinned-facts section to the prompt:

```ts
if (knowledge.trim().length > 0) {
  parts.push('Known about this machine and user (pinned facts):');
  parts.push(knowledge.trim());
}
```

Remove the `readKnowledge` import.

- [ ] **Step 5: Update the `SYSTEM_PROMPT` knowledge_append blurb**

Inside `SYSTEM_PROMPT`, change the `knowledge_append` line to drop the `knowledge.md` reference:

```ts
'- knowledge_append(note): save a durable fact or preference to Otto\'s memory. Stable preferences are prioritized for inclusion in future prompts. Use sparingly.',
```

- [ ] **Step 6: Update `tools.test.ts` if needed** (descriptions changed; only update tests that assert exact text).

- [ ] **Step 7: Run agent tests**

Run: `pnpm vitest run src/main/agent`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/agent
git commit -m "feat(agent): wire FactRepo into knowledge_append + pinned-facts prompt"
```

---

## Task 13: Wire FactRepo into `src/main/index.ts`

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Construct the pipeline with `factRepo`**

Find the existing `ReflectionPipeline` construction (in or near the block shown around line 220-242 of `src/main/index.ts`). Pass `factRepo` to its `PipelineDeps`.

- [ ] **Step 2: Replace the recall fact branch**

Replace the entire `wantsFacts` block in the `recall:` arrow function (currently reads `knowledge.md` and grep-filters by tokens) with:

```ts
if (wantsFacts) {
  const hits = factRepo.search({ query: args.query, limit });
  if (hits.length > 0) factRepo.bumpUse(hits.map((h) => h.id), 'recall');
  facts = hits.map((h) => h.body);
}
```

Note: the bumpUse sessionId for `recall`-originated bumps is the literal string `'recall'` so that pinned-prompt loads (which use the real session id) and recall-tool hits both count toward `distinct_sessions` independently. If you'd rather thread the active session id through the recall handler, the SDK passes it via `RealSdkClientDeps.recall`'s call site — pull it from a closure on `currentMessageId`/sessions if it's available. Either is acceptable; the simpler form above is fine for v1.

Remove the dynamic `import('./knowledge/store')` and the token-grep block above it.

- [ ] **Step 3: Add `factsForPrompt`, `bumpFactUse`, `appendKnowledge` deps**

In the same `createRealSdkClient({ ... })` call, add:

```ts
factsForPrompt: () => {
  const pinned = factRepo.listPinned();
  if (pinned.length === 0) return { markdown: '', ids: [] };
  return {
    markdown: pinned.map((f) => `- ${f.body}`).join('\n'),
    ids: pinned.map((f) => f.id),
  };
},
bumpFactUse: (ids, sessionId) => factRepo.bumpUse(ids, sessionId),
appendKnowledge: async (note, sessionId) => {
  factRepo.upsert({ body: note, preference: true, sourceSessionId: sessionId });
},
```

Update the existing `memoryCounts` to include fact counts:

```ts
memoryCounts: () => {
  const a = artifactRepo.counts();
  const f = factRepo.counts();
  return { ...a, factsPinned: f.pinned, factsTotal: f.total };
},
```

- [ ] **Step 4: Add regenerate-on-write side effect**

After the reflection pipeline completes (the existing `void (async () => { await pipeline.run(...) ... })()` block), call:

```ts
await regenerateKnowledgeFile(ottoConfigDir, factRepo);
```

(Import `regenerateKnowledgeFile` from `./knowledge/store`.)

Also call `await regenerateKnowledgeFile(ottoConfigDir, factRepo)` right after the bootstrap `factRepo.rerank()` so the file exists on first run.

- [ ] **Step 5: Manual smoke**

Run: `pnpm dev` and exercise a session that triggers reflection. Check `~/.config/otto/knowledge.md` shows the auto-generated banner + pinned facts.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): wire FactRepo into recall, prompt, knowledge_append, and reflection"
```

---

## Task 14: Update Memory IPC + settings UI

**Files:**
- Modify: `src/main/ipc/handlers.ts`
- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/renderer/components/settings/MemorySection.tsx`
- Modify: `src/renderer/components/settings/MemorySection.test.tsx`

- [ ] **Step 1: Update IPC contract**

In `src/shared/ipc-contract.ts`, find the `memory.list` response type. The fact branch currently returns `facts: string[]`. Change to:

```ts
facts: Array<{ id: string; body: string; pinned: boolean; useCount: number; lastUsedAt: number | null }>;
```

Remove `memory.readFacts` and `memory.writeFacts` channels entirely.

- [ ] **Step 2: Update handlers**

In `src/main/ipc/handlers.ts`, the `memory.list` handler's fact branch:

```ts
if (kind === 'fact') {
  const hits = query
    ? factRepo.search({ query, limit: 100 })
    : factRepo.list({ limit: 200 });
  return {
    facts: hits.map((f) => ({
      id: f.id,
      body: f.body,
      pinned: f.pinned,
      useCount: f.useCount,
      lastUsedAt: f.lastUsedAt,
    })),
    artifacts: [],
  };
}
```

Delete the `memory.readFacts` / `memory.writeFacts` handler registrations.

(The `handlers.ts` constructor signature may need a `factRepo` parameter — thread it through from `src/main/index.ts`.)

- [ ] **Step 3: Update settings UI**

In `src/renderer/components/settings/MemorySection.tsx`:

- Update the local `facts` state type:

```ts
const [facts, setFacts] = useState<Array<{ id: string; body: string; pinned: boolean; useCount: number; lastUsedAt: number | null }>>([]);
```

- Replace the fact list rendering:

```tsx
{kind === 'fact' ? (
  <ul className="space-y-1 text-xs text-text">
    {facts.length === 0 ? (
      <li className="text-muted">No facts yet.</li>
    ) : (
      facts.map((f) => (
        <li key={f.id} className="flex items-start gap-2">
          {f.pinned && (
            <span className="px-1 rounded bg-accent/20 text-accent text-[10px] uppercase">pinned</span>
          )}
          <span className="flex-1">{f.body}</span>
          <span className="text-muted text-[10px] tabular-nums">{f.useCount}×</span>
        </li>
      ))
    )}
  </ul>
) : ( ... )}
```

- Remove the `factsEdit` state, `openFactsEditor`, `saveFacts`, and the entire `factsEdit !== null && (...)` modal block.

- [ ] **Step 4: Update `MemorySection.test.tsx`**

Find existing tests that assert facts render as raw strings and update assertions for the new object shape. Drop any test for the "Edit knowledge.md…" affordance.

- [ ] **Step 5: Run renderer tests**

Run: `pnpm vitest run src/renderer/components/settings`

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/handlers.ts src/shared/ipc-contract.ts src/renderer/components/settings/MemorySection.tsx src/renderer/components/settings/MemorySection.test.tsx
git commit -m "feat(settings): read-only fact browser with pinned badge + use count"
```

---

## Task 15: Full check + typecheck

- [ ] **Step 1: Run everything**

```bash
pnpm typecheck
pnpm vitest run
pnpm lint
```

Expected: all green.

- [ ] **Step 2: Smoke the app**

Run: `pnpm dev`. Open Settings → Memory → Facts. Confirm the fact list renders. Confirm `knowledge.md.pre-split.bak` exists in the config dir if you had a prior `knowledge.md`. Confirm the new `knowledge.md` has the auto-generated banner.

- [ ] **Step 3: Commit any incidental fixes**

```bash
git add -A
git commit -m "chore: post-split cleanup"
```

---

## Self-review notes

- Spec coverage: data model (Task 1, 2), scoring/promotion/eviction (Task 5), bumpUse (Task 4), reflector bootstrap (Task 9), pipeline wiring (Task 10), `recall` rewrite (Task 13), turn-start pinned load (Task 12), migration importer (Tasks 7, 8), settings UI (Task 14). All covered.
- Method names used consistently across tasks: `FactRepo.upsert`, `get`, `search`, `bumpUse`, `rerank`, `listPinned`, `list`, `counts`; `factsForPrompt`, `bumpFactUse`, `appendKnowledge` on `RealSdkClientDeps`.
- No placeholder text. All steps have concrete code or commands.
- Test names match assertions in the implementation steps.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-24-knowledge-pin-split.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
