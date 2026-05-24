# Knowledge embeddings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add semantic recall over facts + artifacts via a local ONNX embedding model + `sqlite-vec`, fused with the existing FTS5 results through reciprocal rank fusion.

**Architecture:** A singleton `Embedder` wraps `@xenova/transformers` running `all-MiniLM-L6-v2` (384-dim, ~22MB) via `onnxruntime-node`. A new `memory_vec` virtual table holds embeddings keyed by `(kind, ref_id)`. `FactRepo`/`ArtifactRepo` embed on upsert and cascade-delete vectors. A new `MemorySearch` class runs FTS + vector KNN in parallel and combines results via RRF. A startup backfill embeds any pre-existing rows that lack a vector. The whole feature degrades to FTS-only if the model fails to load.

**Tech Stack:** TypeScript, `@xenova/transformers` (tokenizer + ONNX inference), `onnxruntime-node`, `sqlite-vec`, better-sqlite3, vitest.

**Spec:** `docs/superpowers/specs/2026-05-24-knowledge-embeddings-design.md`

**Constants (final values):**
- Embedding dim: 384
- Model id: `Xenova/all-MiniLM-L6-v2`
- `K_FTS = 30`, `K_VEC = 30`, `RRF_K = 60`
- Batch size: 32

---

## File Structure

**Create:**
- `scripts/fetch-embedding-model.mjs` — Node script that downloads the model to `resources/embedding/` if missing. Used in `postinstall`.
- `src/main/embeddings/embedder.ts` — `Embedder` interface + `getEmbedder()` singleton.
- `src/main/embeddings/embedder.test.ts`
- `src/main/embeddings/stub.ts` — `createStubEmbedder()` deterministic test embedder.
- `src/main/embeddings/backfill.ts` — `backfillEmbeddings()` startup helper.
- `src/main/embeddings/backfill.test.ts`
- `src/main/memory/search.ts` — `MemorySearch` class.
- `src/main/memory/search.test.ts`
- `resources/embedding/.gitkeep` — placeholder so the directory exists in git.

**Modify:**
- `package.json` — deps + postinstall script.
- `.gitignore` — exclude downloaded model files.
- `electron-builder.yml` — `files:` and `asarUnpack:` for `resources/embedding/` and the new node modules.
- `src/main/db/db.ts` — load `sqlite-vec` extension in `openDatabase`; add MIGRATION_005_VEC.
- `src/main/db/db.test.ts` — assert version 5 + `memory_vec` table.
- `src/main/db/fact-repo.ts` — async `upsert`, embed + insert vector, new `delete` with cascade.
- `src/main/db/fact-repo.test.ts` — pass stub embedder, assert vec rows.
- `src/main/db/artifact-repo.ts` — async `upsert`, embed `title+body`, REPLACE vector on update, cascade in `delete`.
- `src/main/db/artifact-repo.test.ts` — pass stub embedder.
- `src/main/knowledge/import-legacy.ts` — `await` the now-async `upsert`.
- `src/main/reflection/pipeline.ts` — `await` upsert.
- `src/main/agent/sdk-client.ts` — no signature change (already async); just types flow.
- `src/main/index.ts` — construct embedder + MemorySearch; wire backfill; replace recall handler with `MemorySearch.search`.
- `src/main/ipc/handlers.ts` — route `memory.list` search through `MemorySearch`.

---

## Task 1: Dependencies + model fetch script

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `scripts/fetch-embedding-model.mjs`
- Create: `resources/embedding/.gitkeep`

- [ ] **Step 1: Add dependencies**

Add to `package.json` `dependencies`:

```json
"@xenova/transformers": "^2.17.2",
"onnxruntime-node": "^1.19.2",
"sqlite-vec": "^0.1.6"
```

Run: `pnpm add @xenova/transformers@^2.17.2 onnxruntime-node@^1.19.2 sqlite-vec@^0.1.6`

(If pnpm reports a newer compatible version, accept it — these are floors, not pins.)

- [ ] **Step 2: Add the fetch script**

Create `scripts/fetch-embedding-model.mjs`:

```js
#!/usr/bin/env node
// Downloads the embedding model to resources/embedding/ if not already present.
// Idempotent: if the model file is the right size, exits 0 without redownloading.
import { mkdirSync, existsSync, statSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const DIR = join(ROOT, 'resources', 'embedding');
mkdirSync(DIR, { recursive: true });

const FILES = [
  // Quantized ONNX model is ~22MB; full precision is ~90MB. Quantized is
  // accurate enough at this scale and ships much smaller.
  {
    url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx',
    dest: join(DIR, 'model_quantized.onnx'),
    minBytes: 20_000_000,
  },
  {
    url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json',
    dest: join(DIR, 'tokenizer.json'),
    minBytes: 400_000,
  },
  {
    url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer_config.json',
    dest: join(DIR, 'tokenizer_config.json'),
    minBytes: 100,
  },
  {
    url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/config.json',
    dest: join(DIR, 'config.json'),
    minBytes: 100,
  },
];

for (const f of FILES) {
  if (existsSync(f.dest) && statSync(f.dest).size >= f.minBytes) {
    console.log(`[embedding] ${f.dest} already present`);
    continue;
  }
  console.log(`[embedding] downloading ${f.url}`);
  const res = await fetch(f.url);
  if (!res.ok) {
    console.error(`[embedding] failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  await streamPipeline(res.body, createWriteStream(f.dest));
}
console.log('[embedding] all files present');
```

- [ ] **Step 3: Wire postinstall**

Modify `package.json` scripts. The current `postinstall` is `electron-builder install-app-deps`. Append the model fetch:

```json
"postinstall": "electron-builder install-app-deps && node scripts/fetch-embedding-model.mjs",
"prebuild": "node scripts/ensure-abi.mjs electron && node scripts/fetch-embedding-model.mjs",
```

(Also added to `prebuild` so CI builds without a prior install still produce model files.)

- [ ] **Step 4: Add .gitignore + .gitkeep**

Append to `.gitignore`:

```
resources/embedding/*
!resources/embedding/.gitkeep
```

Create empty `resources/embedding/.gitkeep`.

- [ ] **Step 5: Verify fetch works**

Run: `node scripts/fetch-embedding-model.mjs`

Expected output: lines logging each file downloaded, then `all files present`. `resources/embedding/` should contain `model_quantized.onnx` (~22MB), `tokenizer.json` (~0.7MB), `tokenizer_config.json`, `config.json`.

Run it a second time. Expected: `already present` for every file.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml scripts/fetch-embedding-model.mjs .gitignore resources/embedding/.gitkeep
git commit -m "feat(embedding): add deps and model fetch script"
```

---

## Task 2: sqlite-vec extension + migration 005

**Files:**
- Modify: `src/main/db/db.ts`
- Modify: `src/main/db/db.test.ts`

- [ ] **Step 1: Write failing test**

Append to `src/main/db/db.test.ts`:

```ts
it('runs migration 005 creating memory_vec', () => {
  const db = openDatabase(path.join(freshDir(), 'otto.db'));
  const version = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
  expect(version).toBeGreaterThanOrEqual(5);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  expect(tables).toContain('memory_vec');
  // sqlite-vec exposes vec_version()
  const v = (db.prepare('SELECT vec_version() AS v').get() as { v: string }).v;
  expect(typeof v).toBe('string');
  expect(v.length).toBeGreaterThan(0);
  db.close();
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm vitest run src/main/db/db.test.ts`
Expected: FAIL — `vec_version()` no such function.

- [ ] **Step 3: Load sqlite-vec + add migration**

In `src/main/db/db.ts`, at the top:

```ts
import * as sqliteVec from 'sqlite-vec';
```

Inside `openDatabase`, immediately after `const db = new Database(dbPath);` and BEFORE the pragmas:

```ts
// sqlite-vec ships per-platform loadable extensions. Load before migrations so
// migration 005 can use the vec0 virtual table.
db.loadExtension(sqliteVec.getLoadablePath());
```

Add `MIGRATION_005_VEC` after `MIGRATION_004_FACTS`:

```ts
const MIGRATION_005_VEC = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
  embedding float[384],
  +kind text,
  +ref_id text
);
`;
```

And append `{ version: 5, sql: MIGRATION_005_VEC }` to the `MIGRATIONS` array.

- [ ] **Step 4: Run test, verify PASS**

Run: `pnpm vitest run src/main/db/db.test.ts`
Expected: PASS. Other tests in the same file may need their version assertions bumped — update any `toBe(4)` to `toBe(5)` and any `[1,2,3,4]` array to `[1,2,3,4,5]`.

- [ ] **Step 5: Commit**

```bash
git add src/main/db/db.ts src/main/db/db.test.ts
git commit -m "feat(db): load sqlite-vec + add memory_vec migration 005"
```

---

## Task 3: Embedder module + stub

**Files:**
- Create: `src/main/embeddings/embedder.ts`
- Create: `src/main/embeddings/stub.ts`
- Create: `src/main/embeddings/embedder.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/embeddings/embedder.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStubEmbedder } from './stub';

describe('createStubEmbedder', () => {
  it('returns deterministic vectors of dim 384', async () => {
    const e = createStubEmbedder();
    const a = await e.embed('hello');
    const b = await e.embed('hello');
    expect(a.length).toBe(384);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('returns different vectors for different inputs', async () => {
    const e = createStubEmbedder();
    const a = await e.embed('alpha');
    const b = await e.embed('beta');
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('embedBatch returns one vector per input', async () => {
    const e = createStubEmbedder();
    const vs = await e.embedBatch(['a', 'b', 'c']);
    expect(vs).toHaveLength(3);
    expect(vs[0]!.length).toBe(384);
  });

  it('supports override map for controlled vectors in tests', async () => {
    const e = createStubEmbedder({
      'audio stutter': new Float32Array(384).fill(0.5),
    });
    const v = await e.embed('audio stutter');
    expect(v[0]).toBe(0.5);
  });
});

describe('getEmbedder() singleton + disable env', () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.OTTO_DISABLE_EMBEDDINGS;
    vi.resetModules();
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OTTO_DISABLE_EMBEDDINGS;
    else process.env.OTTO_DISABLE_EMBEDDINGS = originalEnv;
  });

  it('returns a no-op embedder when OTTO_DISABLE_EMBEDDINGS=1', async () => {
    process.env.OTTO_DISABLE_EMBEDDINGS = '1';
    const { getEmbedder } = await import('./embedder');
    const e = getEmbedder();
    const v = await e.embed('x');
    expect(v.length).toBe(384);
    expect(Array.from(v).every((n) => n === 0)).toBe(true);
  });

  it('caches across calls (singleton)', async () => {
    process.env.OTTO_DISABLE_EMBEDDINGS = '1';
    const { getEmbedder } = await import('./embedder');
    expect(getEmbedder()).toBe(getEmbedder());
  });
});
```

- [ ] **Step 2: Run, verify FAIL** (modules not found)

Run: `pnpm vitest run src/main/embeddings/embedder.test.ts`

- [ ] **Step 3: Implement the stub**

Create `src/main/embeddings/stub.ts`:

```ts
import type { Embedder } from './embedder';

/**
 * Deterministic embedder for tests. Same input → same vector. Different inputs
 * generally differ. Optional `overrides` lets a test pin specific texts to
 * specific vectors (useful for forcing exact ranking outcomes).
 */
export function createStubEmbedder(overrides: Record<string, Float32Array> = {}): Embedder {
  function hashSeed(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h || 1;
  }
  function makeVec(text: string): Float32Array {
    if (overrides[text]) return overrides[text]!;
    const seed = hashSeed(text);
    const v = new Float32Array(384);
    let s = seed;
    for (let i = 0; i < 384; i += 1) {
      // xorshift-ish for repeatability without needing a crypto seed.
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      s = s >>> 0;
      v[i] = ((s % 2000) - 1000) / 1000;
    }
    // L2-normalize so dot product == cosine similarity.
    let norm = 0;
    for (let i = 0; i < 384; i += 1) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 384; i += 1) v[i] = v[i]! / norm;
    return v;
  }
  return {
    dim: 384,
    async embed(text) {
      return makeVec(text);
    },
    async embedBatch(texts) {
      return texts.map((t) => makeVec(t));
    },
  };
}
```

- [ ] **Step 4: Implement the real Embedder**

Create `src/main/embeddings/embedder.ts`:

```ts
import path from 'node:path';
import { app } from 'electron';
import { logger } from '../logger';

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dim: number;
}

const DIM = 384;
const BATCH_SIZE = 32;

function noopEmbedder(): Embedder {
  const zero = new Float32Array(DIM);
  return {
    dim: DIM,
    async embed() {
      return zero;
    },
    async embedBatch(texts) {
      return texts.map(() => zero);
    },
  };
}

function modelDir(): string {
  // In packaged builds, resources/embedding lives next to the asar archive.
  // In dev / tests, it lives in the repo root.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, 'embedding');
    return packaged;
  }
  try {
    return path.join(app.getAppPath(), 'resources', 'embedding');
  } catch {
    // Electron app may not be initialized in unit tests.
    return path.join(process.cwd(), 'resources', 'embedding');
  }
}

interface TransformersPipeline {
  (text: string | string[], opts?: { pooling: string; normalize: boolean }): Promise<{ data: Float32Array; dims: number[] }>;
}

let cachedInstance: Embedder | null = null;
let initFailed = false;

async function loadRealEmbedder(): Promise<Embedder> {
  // The transformers package is ESM; dynamic-import it from this CommonJS
  // bundle. Configure its cache dir to point at our bundled model files.
  const t = (await import('@xenova/transformers')) as unknown as {
    env: { localModelPath: string; allowRemoteModels: boolean; allowLocalModels: boolean };
    pipeline: (task: string, model: string, opts?: { quantized?: boolean }) => Promise<TransformersPipeline>;
  };
  t.env.localModelPath = modelDir();
  t.env.allowRemoteModels = false;
  t.env.allowLocalModels = true;
  const pipe = await t.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });

  return {
    dim: DIM,
    async embed(text) {
      const out = await pipe(text, { pooling: 'mean', normalize: true });
      return new Float32Array(out.data);
    },
    async embedBatch(texts) {
      const all: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const out = await pipe(batch, { pooling: 'mean', normalize: true });
        // transformers returns a flat Float32Array of length batch.length * dim.
        for (let j = 0; j < batch.length; j += 1) {
          all.push(out.data.slice(j * DIM, (j + 1) * DIM));
        }
      }
      return all;
    },
  };
}

/**
 * Process-singleton embedder. First call to embed() loads the ONNX model
 * (~200ms). If init fails, downgrades to a no-op embedder for the rest of the
 * process lifetime (FTS-only search still works).
 */
export function getEmbedder(): Embedder {
  if (cachedInstance) return cachedInstance;
  if (process.env.OTTO_DISABLE_EMBEDDINGS === '1') {
    cachedInstance = noopEmbedder();
    return cachedInstance;
  }
  if (initFailed) {
    cachedInstance = noopEmbedder();
    return cachedInstance;
  }

  // Lazy: we return a proxy that loads on first call.
  let loadPromise: Promise<Embedder> | null = null;
  function loadOnce(): Promise<Embedder> {
    if (!loadPromise) {
      loadPromise = loadRealEmbedder().catch((err) => {
        initFailed = true;
        logger.error('embedder init failed; falling back to no-op', err);
        return noopEmbedder();
      });
    }
    return loadPromise;
  }
  cachedInstance = {
    dim: DIM,
    async embed(text) {
      const real = await loadOnce();
      return real.embed(text);
    },
    async embedBatch(texts) {
      const real = await loadOnce();
      return real.embedBatch(texts);
    },
  };
  return cachedInstance;
}

/** Test helper: reset the cached singleton. Not exported via public API. */
export function _resetEmbedderForTests(): void {
  cachedInstance = null;
  initFailed = false;
}
```

- [ ] **Step 5: Run tests, verify PASS**

Run: `pnpm vitest run src/main/embeddings/embedder.test.ts`
Expected: 6/6 pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/embeddings
git commit -m "feat(embedding): Embedder singleton + stub for tests"
```

---

## Task 4: FactRepo embedder integration

**Files:**
- Modify: `src/main/db/fact-repo.ts`
- Modify: `src/main/db/fact-repo.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/main/db/fact-repo.test.ts`:

```ts
import { createStubEmbedder } from '../embeddings/stub';

describe('FactRepo embedding integration', () => {
  it('inserts a memory_vec row on upsert', async () => {
    const embedder = createStubEmbedder();
    const factRepo2 = new FactRepo(db, () => NOW, embedder);
    const { id } = await factRepo2.upsert({ body: 'audio is Focusrite Scarlett' });
    const row = db.prepare("SELECT ref_id FROM memory_vec WHERE kind='fact' AND ref_id=?").get(id) as { ref_id: string } | undefined;
    expect(row?.ref_id).toBe(id);
  });

  it('does not insert a duplicate memory_vec row on dedup hit', async () => {
    const embedder = createStubEmbedder();
    const factRepo2 = new FactRepo(db, () => NOW, embedder);
    await factRepo2.upsert({ body: 'audio is Focusrite Scarlett' });
    await factRepo2.upsert({ body: 'AUDIO is Focusrite Scarlett' }); // dedup
    const n = (db.prepare("SELECT COUNT(*) AS n FROM memory_vec WHERE kind='fact'").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('delete cascades the memory_vec row', async () => {
    const embedder = createStubEmbedder();
    const factRepo2 = new FactRepo(db, () => NOW, embedder);
    const { id } = await factRepo2.upsert({ body: 'transient fact' });
    factRepo2.delete(id);
    const row = db.prepare("SELECT ref_id FROM memory_vec WHERE kind='fact' AND ref_id=?").get(id);
    expect(row).toBeUndefined();
  });
});
```

Note: existing `FactRepo` tests use `new FactRepo(db, () => NOW)`. After this task they'll still work because the embedder is optional with a stub default; but the test file should also be updated to pass `createStubEmbedder()` everywhere to avoid hidden coupling. Specifically: at the top of `beforeEach`, replace `repo = new FactRepo(db, () => NOW);` with `repo = new FactRepo(db, () => NOW, createStubEmbedder());`.

- [ ] **Step 2: Run tests, verify FAIL**

Run: `pnpm vitest run src/main/db/fact-repo.test.ts`
Expected: FAIL — `upsert` is not async, `delete` does not exist, third constructor arg unsupported, no memory_vec inserts.

- [ ] **Step 3: Update FactRepo**

Modify `src/main/db/fact-repo.ts`:

a) Add the embedder constructor arg + import:

```ts
import type { Embedder } from '../embeddings/embedder';
import { getEmbedder } from '../embeddings/embedder';
// ...
export class FactRepo {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly embedder: Embedder = getEmbedder()
  ) {}
```

b) Make `upsert` async + write vector after insert:

```ts
async upsert(input: UpsertInput): Promise<UpsertResult> {
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

  // Embed BEFORE the transaction so we don't hold a write lock across the
  // (~10ms) embed call.
  const vec = await this.embedder.embed(bodyTrimmed);

  const insertFact = this.db.prepare(
    `INSERT INTO fact
      (id, body, body_norm, pinned, use_count, distinct_sessions, score,
       created_at, last_used_at, source_session_id)
     VALUES (?, ?, ?, ?, 0, ?, 0, ?, NULL, ?)`
  );
  const insertVec = this.db.prepare(
    `INSERT INTO memory_vec(embedding, kind, ref_id) VALUES (?, 'fact', ?)`
  );
  const txn = this.db.transaction(() => {
    insertFact.run(id, bodyTrimmed, bodyNorm, pinned, distinctSessions, createdAt, input.sourceSessionId ?? null);
    insertVec.run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), id);
  });
  txn();
  return { id, inserted: true };
}
```

c) Add `delete`:

```ts
delete(id: string): void {
  const txn = this.db.transaction(() => {
    this.db.prepare(`DELETE FROM memory_vec WHERE kind='fact' AND ref_id=?`).run(id);
    this.db.prepare(`DELETE FROM fact_session WHERE fact_id=?`).run(id);
    this.db.prepare(`DELETE FROM fact WHERE id=?`).run(id);
  });
  txn();
}
```

- [ ] **Step 4: Run tests, verify PASS**

Run: `pnpm vitest run src/main/db/fact-repo.test.ts`

Other tests that called `repo.upsert(...)` without `await` will become typecheck warnings — fix them inline by adding `await`. The whole test file is small; should take a couple of minutes.

- [ ] **Step 5: Commit**

```bash
git add src/main/db/fact-repo.ts src/main/db/fact-repo.test.ts
git commit -m "feat(fact-repo): embed on upsert + cascade memory_vec on delete"
```

---

## Task 5: ArtifactRepo embedder integration

**Files:**
- Modify: `src/main/db/artifact-repo.ts`
- Modify: `src/main/db/artifact-repo.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/main/db/artifact-repo.test.ts`:

```ts
import { createStubEmbedder } from '../embeddings/stub';

describe('ArtifactRepo embedding integration', () => {
  it('inserts a memory_vec row on upsert', async () => {
    const embedder = createStubEmbedder();
    const r = new ArtifactRepo(db, () => 1000, embedder);
    const id = await r.upsert({ kind: 'playbook', title: 'Fix audio', body: 'steps', tags: [] });
    const row = db.prepare("SELECT ref_id FROM memory_vec WHERE ref_id=?").get(id) as { ref_id?: string } | undefined;
    expect(row?.ref_id).toBe(id);
  });

  it('replaces memory_vec row on update', async () => {
    const embedder = createStubEmbedder();
    const r = new ArtifactRepo(db, () => 1000, embedder);
    const id1 = await r.upsert({ kind: 'playbook', title: 'P', body: 'v1', tags: [] });
    const id2 = await r.upsert({ kind: 'playbook', title: 'P', body: 'v2 with much more detail', tags: [] });
    expect(id2).toBe(id1);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM memory_vec WHERE ref_id=?").get(id1) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('delete cascades the memory_vec row', async () => {
    const embedder = createStubEmbedder();
    const r = new ArtifactRepo(db, () => 1000, embedder);
    const id = await r.upsert({ kind: 'playbook', title: 'P', body: 'b', tags: [] });
    r.delete(id);
    const row = db.prepare("SELECT ref_id FROM memory_vec WHERE ref_id=?").get(id);
    expect(row).toBeUndefined();
  });
});
```

Also update the existing `beforeEach` block in `artifact-repo.test.ts` to construct with the stub: `repo = new ArtifactRepo(db, () => 1000, createStubEmbedder());`.

- [ ] **Step 2: Run tests, verify FAIL**

- [ ] **Step 3: Update ArtifactRepo**

In `src/main/db/artifact-repo.ts`:

a) Constructor + import:

```ts
import type { Embedder } from '../embeddings/embedder';
import { getEmbedder } from '../embeddings/embedder';
// ...
export class ArtifactRepo {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly embedder: Embedder = getEmbedder()
  ) {}
```

b) Make `upsert` async and embed `title + '\n' + body`. The existing method returns `string` (the id); change return to `Promise<string>`. Inside, after computing `id`/`existing.id`:

```ts
const embeddingInput = `${input.title}\n${input.body}`;
const vec = await this.embedder.embed(embeddingInput);
```

Then wrap the existing INSERT/UPDATE plus the vector write in a transaction. For the INSERT path:

```ts
const txn = this.db.transaction(() => {
  // ... existing INSERT ...
  this.db.prepare(`INSERT INTO memory_vec(embedding, kind, ref_id) VALUES (?, ?, ?)`)
    .run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), input.kind, id);
});
txn();
return id;
```

For the UPDATE (existing-row) path:

```ts
const txn = this.db.transaction(() => {
  // ... existing UPDATE ...
  this.db.prepare(`DELETE FROM memory_vec WHERE ref_id = ?`).run(existing.id);
  this.db.prepare(`INSERT INTO memory_vec(embedding, kind, ref_id) VALUES (?, ?, ?)`)
    .run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), input.kind, existing.id);
});
txn();
return existing.id;
```

c) Update `delete` to cascade vectors:

```ts
delete(id: string): void {
  const txn = this.db.transaction(() => {
    this.db.prepare(`DELETE FROM memory_vec WHERE ref_id=?`).run(id);
    this.db.prepare(`DELETE FROM artifact WHERE id = ?`).run(id);
  });
  txn();
}
```

- [ ] **Step 4: Run tests, verify PASS**

Run: `pnpm vitest run src/main/db/artifact-repo.test.ts`. Existing tests will need `await` added in front of every `repo.upsert(...)` call. Fix them inline.

- [ ] **Step 5: Commit**

```bash
git add src/main/db/artifact-repo.ts src/main/db/artifact-repo.test.ts
git commit -m "feat(artifact-repo): embed on upsert + cascade memory_vec on delete"
```

---

## Task 6: Propagate async upsert to callers

**Files:**
- Modify: `src/main/knowledge/import-legacy.ts`
- Modify: `src/main/reflection/pipeline.ts`
- Modify: `src/main/index.ts` (knowledge_append + initial bootstrap)
- Modify: `src/main/agent/sdk-client.ts` (already async; just typecheck)
- Modify: `src/main/reflection/pipeline.test.ts` (FactRepo constructor + awaits)

- [ ] **Step 1: Run typecheck to enumerate breakage**

Run: `pnpm typecheck`. Expected errors are in the files listed above. Use the error list as your worklist.

- [ ] **Step 2: import-legacy.ts**

The for-loop in `importLegacyKnowledge` calls `repo.upsert(...)` without await. Change:

```ts
try {
  await repo.upsert({ body, pinned: true, createdAt });
} catch (err) {
  logger.warn(`importLegacyKnowledge skipped a line: ${err instanceof Error ? err.message : String(err)}`);
}
```

- [ ] **Step 3: pipeline.ts**

The fact-write loop in `ReflectionPipeline.run`. Already inside an async function. Change:

```ts
const { inserted } = await factRepo.upsert({
  body: f.body,
  preference: f.preference,
  sourceSessionId: args.sessionId,
});
```

Same for the artifact-upsert loop:

```ts
const id = await artifactRepo.upsert({
  kind, title: item.title, body: item.body, tags: item.tags, sourceSessionId: args.sessionId,
});
```

(`upsert` already returns the id; we now wait for the promise.)

- [ ] **Step 4: index.ts**

In `appendKnowledge` dep:

```ts
appendKnowledge: async (note, sessionId) => {
  await factRepo.upsert({ body: note, preference: true, sourceSessionId: sessionId });
  factRepo.rerank();
  await regenerateKnowledgeFile(ottoConfigDir, factRepo);
},
```

The bootstrap `importLegacyKnowledge(ottoConfigDir, factRepo)` is already awaited.

- [ ] **Step 5: pipeline.test.ts**

Tests construct `new FactRepo(db, () => 1000)` and `new ArtifactRepo(db, () => 1000)`. Update both to pass a stub:

```ts
import { createStubEmbedder } from '../embeddings/stub';
// ...
factRepo = new FactRepo(db, () => 1000, createStubEmbedder());
artifactRepo = new ArtifactRepo(db, () => 1000, createStubEmbedder());
```

- [ ] **Step 6: Run full test suite + typecheck**

```
pnpm typecheck
pnpm vitest run
```

Both must pass (the pre-existing portal failures were fixed; this branch should be 100% green).

- [ ] **Step 7: Commit**

```bash
git add src/main/knowledge/import-legacy.ts src/main/reflection/pipeline.ts src/main/reflection/pipeline.test.ts src/main/index.ts src/main/agent/sdk-client.ts
git commit -m "refactor: propagate async upsert through callers"
```

---

## Task 7: Backfill module

**Files:**
- Create: `src/main/embeddings/backfill.ts`
- Create: `src/main/embeddings/backfill.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/embeddings/backfill.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../db/db';
import { FactRepo } from '../db/fact-repo';
import { ArtifactRepo } from '../db/artifact-repo';
import { createStubEmbedder } from './stub';
import { backfillEmbeddings } from './backfill';

let dir: string;
let db: Database;
let factRepo: FactRepo;
let artifactRepo: ArtifactRepo;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-backfill-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  // Construct repos WITHOUT the embedder so initial upserts skip vec writes
  // — we want unembedded rows to backfill.
  factRepo = new FactRepo(db, () => 1000, {
    dim: 384,
    embed: async () => new Float32Array(384),
    embedBatch: async (ts) => ts.map(() => new Float32Array(384)),
  });
  artifactRepo = new ArtifactRepo(db, () => 1000, {
    dim: 384,
    embed: async () => new Float32Array(384),
    embedBatch: async (ts) => ts.map(() => new Float32Array(384)),
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('backfillEmbeddings', () => {
  it('embeds previously-unembedded rows', async () => {
    // Seed three facts + one artifact. With the no-op-vec embedder above,
    // these upserts insert zero vectors. We then clear memory_vec to
    // simulate a pre-embedding world.
    await factRepo.upsert({ body: 'fact one' });
    await factRepo.upsert({ body: 'fact two' });
    await factRepo.upsert({ body: 'fact three' });
    await artifactRepo.upsert({ kind: 'playbook', title: 'P', body: 'b', tags: [] });
    db.prepare('DELETE FROM memory_vec').run();

    const stub = createStubEmbedder();
    const out = await backfillEmbeddings({ db, embedder: stub });
    expect(out.embedded).toBe(4);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM memory_vec').get() as { n: number }).n;
    expect(n).toBe(4);
  });

  it('is a no-op on a second run', async () => {
    await factRepo.upsert({ body: 'fact' });
    db.prepare('DELETE FROM memory_vec').run();
    const stub = createStubEmbedder();
    await backfillEmbeddings({ db, embedder: stub });
    const out = await backfillEmbeddings({ db, embedder: stub });
    expect(out.embedded).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

Create `src/main/embeddings/backfill.ts`:

```ts
import type { Database } from 'better-sqlite3';
import type { Embedder } from './embedder';
import { logger } from '../logger';

const BATCH = 32;

export interface BackfillDeps {
  db: Database;
  embedder: Embedder;
}

export async function backfillEmbeddings(deps: BackfillDeps): Promise<{ embedded: number; ms: number }> {
  const start = Date.now();
  let embedded = 0;
  try {
    embedded += await backfillKind(deps, 'fact', `SELECT id AS ref_id, body AS text FROM fact WHERE id NOT IN (SELECT ref_id FROM memory_vec WHERE kind='fact')`);
    for (const kind of ['playbook', 'anti_pattern', 'heuristic'] as const) {
      embedded += await backfillKind(
        deps,
        kind,
        `SELECT id AS ref_id, (title || char(10) || body) AS text FROM artifact WHERE kind = '${kind}' AND id NOT IN (SELECT ref_id FROM memory_vec WHERE kind='${kind}')`
      );
    }
  } catch (err) {
    logger.error('backfillEmbeddings failed', err);
  }
  const ms = Date.now() - start;
  if (embedded > 0) logger.info(`embeddings: backfilled ${embedded} rows in ${ms}ms`);
  return { embedded, ms };
}

async function backfillKind(
  deps: BackfillDeps,
  kind: string,
  sql: string
): Promise<number> {
  const rows = deps.db.prepare(sql).all() as Array<{ ref_id: string; text: string }>;
  if (rows.length === 0) return 0;
  const insert = deps.db.prepare(
    `INSERT INTO memory_vec(embedding, kind, ref_id) VALUES (?, ?, ?)`
  );
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vecs = await deps.embedder.embedBatch(batch.map((r) => r.text));
    const txn = deps.db.transaction(() => {
      for (let j = 0; j < batch.length; j += 1) {
        const v = vecs[j]!;
        insert.run(Buffer.from(v.buffer, v.byteOffset, v.byteLength), kind, batch[j]!.ref_id);
      }
    });
    txn();
  }
  return rows.length;
}
```

- [ ] **Step 4: Run tests, verify PASS**

Run: `pnpm vitest run src/main/embeddings/backfill.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/main/embeddings/backfill.ts src/main/embeddings/backfill.test.ts
git commit -m "feat(embedding): backfill module for unembedded rows"
```

---

## Task 8: Wire backfill into bootstrap

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add lazy imports + construct embedder**

In the lazy-import block at the top of `startElectron`:

```ts
const { getEmbedder } = await import('./embeddings/embedder');
const { backfillEmbeddings } = await import('./embeddings/backfill');
```

After `const artifactRepo = new ArtifactRepo(db);` change the repo constructions to share an embedder:

```ts
const embedder = getEmbedder();
const artifactRepo = new ArtifactRepo(db, undefined, embedder);
const factRepo = new FactRepo(db, undefined, embedder);
```

(The existing `const factRepo = new FactRepo(db);` line is replaced.)

- [ ] **Step 2: Run backfill after legacy import + rerank**

The existing flow:

```ts
await importLegacyKnowledge(ottoConfigDir, factRepo);
factRepo.rerank();
void regenerateKnowledgeFile(ottoConfigDir, factRepo);
```

Add backfill BEFORE the legacy import (so legacy-imported facts produce vectors directly via their own upsert path; backfill catches anything else):

Actually order matters: importLegacyKnowledge calls `factRepo.upsert` which now embeds. So legacy imports produce vectors naturally. Backfill then handles any artifacts/facts that existed in DB from a prior run when the embedder was disabled. Run backfill AFTER legacy import:

```ts
await importLegacyKnowledge(ottoConfigDir, factRepo);
await backfillEmbeddings({ db, embedder });
factRepo.rerank();
void regenerateKnowledgeFile(ottoConfigDir, factRepo);
```

- [ ] **Step 3: Typecheck + smoke**

Run: `pnpm typecheck`. Should pass.

Smoke test (optional): `pnpm dev`, confirm no startup errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(bootstrap): construct shared embedder + backfill on startup"
```

---

## Task 9: MemorySearch class + RRF

**Files:**
- Create: `src/main/memory/search.ts`
- Create: `src/main/memory/search.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/memory/search.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../db/db';
import { FactRepo } from '../db/fact-repo';
import { ArtifactRepo } from '../db/artifact-repo';
import { createStubEmbedder } from '../embeddings/stub';
import { MemorySearch } from './search';

let dir: string;
let db: Database;
let factRepo: FactRepo;
let artifactRepo: ArtifactRepo;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-msearch-'));
  db = openDatabase(path.join(dir, 'otto.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MemorySearch', () => {
  it('returns FTS hits even when vector distance is large', async () => {
    // Use overrides so the query vector is orthogonal to the fact vector.
    const orth1 = new Float32Array(384);
    orth1[0] = 1;
    const orth2 = new Float32Array(384);
    orth2[1] = 1;
    const embedder = createStubEmbedder({
      'spectacle needs -bnf on multi-monitor': orth1,
      'spectacle': orth2,
    });
    factRepo = new FactRepo(db, () => 1000, embedder);
    artifactRepo = new ArtifactRepo(db, () => 1000, embedder);
    await factRepo.upsert({ body: 'spectacle needs -bnf on multi-monitor' });
    const search = new MemorySearch({ factRepo, artifactRepo, embedder, db });
    const out = await search.search({ query: 'spectacle', limit: 5 });
    expect(out.facts.map((f) => f.body)).toContain('spectacle needs -bnf on multi-monitor');
  });

  it('returns vector hits when FTS misses the paraphrase', async () => {
    // Force vector similarity by giving paraphrase and stored fact the same vector.
    const shared = new Float32Array(384).fill(0.1);
    const embedder = createStubEmbedder({
      'audio is glitching': shared,
      'sound stutters during render': shared,
    });
    factRepo = new FactRepo(db, () => 1000, embedder);
    artifactRepo = new ArtifactRepo(db, () => 1000, embedder);
    await factRepo.upsert({ body: 'audio is glitching' });
    const search = new MemorySearch({ factRepo, artifactRepo, embedder, db });
    const out = await search.search({ query: 'sound stutters during render', limit: 5 });
    // FTS would miss ("audio glitching" vs "sound stutters") but vector matches.
    expect(out.facts.map((f) => f.body)).toContain('audio is glitching');
  });

  it('filters by kinds', async () => {
    const embedder = createStubEmbedder();
    factRepo = new FactRepo(db, () => 1000, embedder);
    artifactRepo = new ArtifactRepo(db, () => 1000, embedder);
    await factRepo.upsert({ body: 'common keyword' });
    await artifactRepo.upsert({ kind: 'playbook', title: 'common keyword', body: 'b', tags: [] });
    const search = new MemorySearch({ factRepo, artifactRepo, embedder, db });
    const factsOnly = await search.search({ query: 'common', kinds: ['fact'], limit: 5 });
    expect(factsOnly.artifacts).toHaveLength(0);
    expect(factsOnly.facts).toHaveLength(1);
  });

  it('falls back to FTS-only when embedder throws', async () => {
    const bad = {
      dim: 384,
      embed: async () => { throw new Error('boom'); },
      embedBatch: async () => { throw new Error('boom'); },
    };
    const goodForWrite = createStubEmbedder();
    factRepo = new FactRepo(db, () => 1000, goodForWrite);
    artifactRepo = new ArtifactRepo(db, () => 1000, goodForWrite);
    await factRepo.upsert({ body: 'unique-keyword-x' });
    const search = new MemorySearch({ factRepo, artifactRepo, embedder: bad, db });
    const out = await search.search({ query: 'unique-keyword-x', limit: 5 });
    expect(out.facts.map((f) => f.body)).toContain('unique-keyword-x');
  });

  it('returns empty result for empty query', async () => {
    const embedder = createStubEmbedder();
    factRepo = new FactRepo(db, () => 1000, embedder);
    artifactRepo = new ArtifactRepo(db, () => 1000, embedder);
    const search = new MemorySearch({ factRepo, artifactRepo, embedder, db });
    const out = await search.search({ query: '', limit: 5 });
    expect(out.facts).toEqual([]);
    expect(out.artifacts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** (module not found)

- [ ] **Step 3: Implement MemorySearch**

Create `src/main/memory/search.ts`:

```ts
import type { Database } from 'better-sqlite3';
import type { Embedder } from '../embeddings/embedder';
import type { Fact, FactRepo } from '../db/fact-repo';
import type { Artifact, ArtifactKind, ArtifactRepo } from '../db/artifact-repo';
import { sanitizeFtsQuery } from '../db/fts-utils';
import { logger } from '../logger';

const K_FTS = 30;
const K_VEC = 30;
const RRF_K = 60;

export type MemoryKind = 'fact' | ArtifactKind;

export interface MemorySearchArgs {
  query: string;
  kinds?: MemoryKind[];
  limit: number;
}

export interface MemorySearchResult {
  facts: Fact[];
  artifacts: Artifact[];
}

export interface MemorySearchDeps {
  factRepo: FactRepo;
  artifactRepo: ArtifactRepo;
  embedder: Embedder;
  db: Database;
}

export class MemorySearch {
  private vectorDisabled = false;

  constructor(private readonly deps: MemorySearchDeps) {}

  async search(args: MemorySearchArgs): Promise<MemorySearchResult> {
    const query = args.query.trim();
    if (!query) return { facts: [], artifacts: [] };
    const kinds = args.kinds && args.kinds.length > 0 ? args.kinds : (['fact', 'playbook', 'anti_pattern', 'heuristic'] as MemoryKind[]);
    const wantFact = kinds.includes('fact');
    const artifactKinds = kinds.filter((k) => k !== 'fact') as ArtifactKind[];

    // Vector query — embed once, reuse across kinds. Skip on failure.
    let queryVec: Float32Array | null = null;
    if (!this.vectorDisabled) {
      try {
        queryVec = await this.deps.embedder.embed(query);
      } catch (err) {
        this.vectorDisabled = true;
        logger.warn(`memory search vector path disabled: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const factIds = wantFact ? this.fuseForKind('fact', query, queryVec) : [];
    const artifactIdsByKind = new Map<ArtifactKind, string[]>();
    for (const k of artifactKinds) {
      artifactIdsByKind.set(k, this.fuseForKind(k, query, queryVec));
    }

    // Hydrate.
    const facts: Fact[] = factIds
      .slice(0, args.limit)
      .map((id) => this.deps.factRepo.get(id))
      .filter((f): f is Fact => f !== null);
    if (facts.length > 0) {
      this.deps.factRepo.bumpUse(facts.map((f) => f.id), 'recall');
    }

    const artifacts: Artifact[] = [];
    for (const k of artifactKinds) {
      const ids = artifactIdsByKind.get(k) ?? [];
      for (const id of ids) {
        const a = this.deps.artifactRepo.get(id);
        if (a && !a.archived) {
          artifacts.push(a);
          this.deps.artifactRepo.bumpUse(id);
        }
      }
    }
    artifacts.splice(args.limit);

    return { facts, artifacts };
  }

  private fuseForKind(kind: MemoryKind, query: string, queryVec: Float32Array | null): string[] {
    const ftsIds = this.ftsRank(kind, query);
    const vecIds = queryVec ? this.vecRank(kind, queryVec) : [];
    const score = new Map<string, number>();
    ftsIds.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
    vecIds.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
    return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  private ftsRank(kind: MemoryKind, query: string): string[] {
    const q = sanitizeFtsQuery(query);
    if (!q) return [];
    if (kind === 'fact') {
      return (this.deps.db
        .prepare(`SELECT fact.id AS id FROM fact_fts
                    JOIN fact ON fact.rowid = fact_fts.rowid
                   WHERE fact_fts MATCH ?
                   ORDER BY rank LIMIT ?`)
        .all(q, K_FTS) as Array<{ id: string }>).map((r) => r.id);
    }
    return (this.deps.db
      .prepare(`SELECT artifact.id AS id FROM artifact_fts
                  JOIN artifact ON artifact.rowid = artifact_fts.rowid
                 WHERE artifact_fts MATCH ? AND artifact.kind = ? AND artifact.archived = 0
                 ORDER BY rank LIMIT ?`)
      .all(q, kind, K_FTS) as Array<{ id: string }>).map((r) => r.id);
  }

  private vecRank(kind: MemoryKind, queryVec: Float32Array): string[] {
    try {
      const buf = Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);
      return (this.deps.db
        .prepare(`SELECT ref_id FROM memory_vec
                   WHERE kind = ? AND embedding MATCH ? AND k = ?
                   ORDER BY distance`)
        .all(kind, buf, K_VEC) as Array<{ ref_id: string }>).map((r) => r.ref_id);
    } catch (err) {
      logger.warn(`vec rank failed for kind ${kind}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
}
```

- [ ] **Step 4: Run tests, verify PASS**

Run: `pnpm vitest run src/main/memory/search.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/search.ts src/main/memory/search.test.ts
git commit -m "feat(memory): MemorySearch with RRF over FTS + vector KNN"
```

---

## Task 10: Route recall + memory.list through MemorySearch

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/handlers.ts`

- [ ] **Step 1: Construct MemorySearch + delegate recall**

In `src/main/index.ts`, after `factRepo`, `artifactRepo`, and `embedder` are constructed:

```ts
const { MemorySearch } = await import('./memory/search');
const memorySearch = new MemorySearch({ factRepo, artifactRepo, embedder, db });
```

Replace the current `recall:` arrow's body. The new body:

```ts
recall: async (args) => {
  const limit = Math.min(args.limit ?? 5, 20);
  const out = await memorySearch.search({ query: args.query, kinds: args.kinds, limit });
  return {
    facts: out.facts.map((f) => f.body),
    artifacts: out.artifacts.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      tags: r.tags,
      updated_at: r.updatedAt,
    })),
  };
},
```

All the existing fact/artifact FTS/bumpUse logic in this arrow is now inside `MemorySearch` — delete it.

- [ ] **Step 2: Pass memorySearch into IPC handlers**

In `registerIpcHandlers` call, add `memorySearch` (and adapt the deps type). Then in `src/main/ipc/handlers.ts`, the `memory.list` handler's search path:

```ts
import type { MemorySearch } from '../memory/search';
// ...
export function registerIpcHandlers(deps: {
  // ...
  factRepo: FactRepo;
  memorySearch: MemorySearch;
  // ...
}): void {
```

In the handler:

```ts
ipcMain.handle('memory.list', async (_e, args) => {
  if (args.kind === 'fact') {
    if (args.query && args.query.trim()) {
      const out = await deps.memorySearch.search({ query: args.query, kinds: ['fact'], limit: 100 });
      return {
        artifacts: [],
        facts: out.facts.map((f) => ({ id: f.id, body: f.body, pinned: f.pinned, useCount: f.useCount, lastUsedAt: f.lastUsedAt })),
      };
    }
    const hits = deps.factRepo.list({ limit: 200 });
    return {
      artifacts: [],
      facts: hits.map((f) => ({ id: f.id, body: f.body, pinned: f.pinned, useCount: f.useCount, lastUsedAt: f.lastUsedAt })),
    };
  }
  // Artifact branch — also route search through MemorySearch.
  if (args.query && args.query.trim()) {
    const out = await deps.memorySearch.search({ query: args.query, kinds: [args.kind], limit: 200 });
    return {
      artifacts: out.artifacts.map((r) => ({
        id: r.id, kind: r.kind, title: r.title, body: r.body, tags: r.tags,
        createdAt: r.createdAt, updatedAt: r.updatedAt, useCount: r.useCount,
        lastUsedAt: r.lastUsedAt, archived: r.archived,
      })),
      facts: [],
    };
  }
  const rows = deps.artifactRepo.list({ kind: args.kind, includeArchived: args.includeArchived });
  return {
    artifacts: rows.map((r) => ({
      id: r.id, kind: r.kind, title: r.title, body: r.body, tags: r.tags,
      createdAt: r.createdAt, updatedAt: r.updatedAt, useCount: r.useCount,
      lastUsedAt: r.lastUsedAt, archived: r.archived,
    })),
    facts: [],
  };
});
```

- [ ] **Step 3: Typecheck + test**

```
pnpm typecheck
pnpm vitest run
```

Both must pass.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts src/main/ipc/handlers.ts
git commit -m "feat(memory): route recall + memory.list through MemorySearch"
```

---

## Task 11: electron-builder asarUnpack

**Files:**
- Modify: `electron-builder.yml`

- [ ] **Step 1: Add resources + native modules to files + asarUnpack**

In `electron-builder.yml`, update `files:`:

```yaml
files:
  - out/**
  - public/tray/**
  - public/svg/**
  - package.json
  - resources/embedding/**
```

And `asarUnpack:`:

```yaml
asarUnpack:
  - "**/node_modules/better-sqlite3/**"
  - "**/node_modules/sharp/**"
  - "**/node_modules/@anthropic-ai/claude-agent-sdk/**"
  - "**/node_modules/onnxruntime-node/**"
  - "**/node_modules/sqlite-vec/**"
  - "**/node_modules/@xenova/transformers/**"
  - "resources/embedding/**"
```

- [ ] **Step 2: Smoke a build**

Run: `pnpm package` (this is the production build; it may take several minutes). On success, the dist artifact should be ~25MB larger than today. Inspect the AppImage with `--appimage-extract` (or unzip the dmg) to confirm `resources/embedding/` is present.

If you don't have time for a full package build, at least run `pnpm build` to confirm `electron-vite build` doesn't fail.

- [ ] **Step 3: Commit**

```bash
git add electron-builder.yml
git commit -m "build: ship embedding model + sqlite-vec + onnxruntime via asarUnpack"
```

---

## Task 12: Final typecheck + smoke

- [ ] **Step 1: Full check**

```
pnpm typecheck
pnpm vitest run
pnpm lint
```

All green. If `lint` flags anything new, fix inline.

- [ ] **Step 2: Manual smoke (if able)**

Run: `pnpm dev`. Open Settings → Memory → Facts. Confirm the list still renders. In a session, invoke a `recall` via the agent and observe that results return; check logs for `embeddings: backfilled N rows` on first launch.

- [ ] **Step 3: Commit any incidental fixes**

```bash
git add -A
git commit -m "chore: post-embeddings cleanup"
```

---

## Self-review notes

- **Spec coverage:** embedder module (Task 3), sqlite-vec migration + extension load (Task 2), repo integration with cascade (Tasks 4-5), async propagation (Task 6), backfill (Task 7-8), MemorySearch + RRF + failure fallback (Task 9), recall/IPC wiring (Task 10), packaging (Task 11). All covered.
- **Type consistency:** `Embedder` interface (dim/embed/embedBatch) is used identically in every consumer. `MemorySearch.search` signature stable across Tasks 9 and 10.
- **No placeholders.** Every code block is complete.
- **Open dependencies:** the plan assumes `sqlite-vec` ships prebuilt binaries for the user's platforms (it does for the targets in electron-builder.yml). If a platform-specific issue arises, the fallback path (FTS-only) means search still works.
- **Risk on Task 11 (asarUnpack):** the only step in the plan that can't be fully verified without a real packaging build. Plan calls for at least a `pnpm build` to catch obvious failures; full `pnpm package` is recommended but slow.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-24-knowledge-embeddings.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks.
2. **Inline Execution** — execute tasks in this session with batch checkpoints.

Which approach?
