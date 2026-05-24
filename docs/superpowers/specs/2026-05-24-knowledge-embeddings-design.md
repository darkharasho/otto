# Knowledge embeddings — design

Date: 2026-05-24
Status: Draft (pending user review)

## Problem

Otto's recall path (the `recall` tool plus the Settings → Memory search box) uses SQLite FTS5 keyword search over `fact_fts` and `artifact_fts`. Keyword search has a known gap: paraphrases miss. "audio stutter" doesn't surface a playbook indexed under "frame hitching." For a coworking agent that's supposed to remember how it solved a problem the last time, that miss matters.

## Goal

Add semantic recall via a small local embedding model and a vector store, fused with the existing FTS results via reciprocal rank fusion. The change should be invisible to the user (no settings, no setup), should not regress exact-keyword recall, and should keep working when the model fails to load.

## Design summary

- **Model:** `all-MiniLM-L6-v2`, ONNX format, ~22MB, 384-dim, run via `onnxruntime-node`.
- **Storage:** `sqlite-vec` extension, single `memory_vec` virtual table keyed by `(kind, ref_id)`.
- **Write path:** synchronous embed-then-insert in `FactRepo.upsert` and `ArtifactRepo.upsert`.
- **Bootstrap:** one-shot backfill at startup for any rows that don't yet have a vector. Idempotent.
- **Read path:** new `MemorySearch` class. Runs FTS and vector KNN in parallel, fuses via RRF, returns ordered hits.
- **Failure mode:** if embedder fails to load, every embed call is a no-op and `MemorySearch` degrades to FTS-only. Logged once.

## Embedder

New module `src/main/embeddings/embedder.ts`.

```ts
export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dim: number; // 384
}
export function getEmbedder(): Embedder;
```

- Process singleton. Lazy-loads the ONNX session on first call (~200ms one-time, then warm).
- Batch size 32. `embed(s)` is a thin wrapper around `embedBatch([s])`.
- Mean-pools the model output, L2-normalizes the result (so cosine similarity collapses to a dot product, which sqlite-vec uses by default).
- Tokenizer: `@xenova/transformers`'s tokenizer-only export, or the bare `tokenizers` JS package. The exact dependency is an implementation detail — what matters is that we don't pull in the full transformers.js runtime, since we only need tokenization + the bundled ONNX runtime.
- Model files (`model.onnx`, `tokenizer.json`, `tokenizer_config.json`) live in `resources/embedding/` and are referenced via `process.resourcesPath` in packaged builds and `app.getAppPath()` in dev. Same pattern as the SDK CLI unpacking in `sdk-client.ts`.
- `electron-builder.yml` gains `asarUnpack: ["resources/embedding/**", "node_modules/sqlite-vec/**", "node_modules/onnxruntime-node/**"]` so the native loaders can mmap the files at runtime.
- Escape hatch: `process.env.OTTO_DISABLE_EMBEDDINGS === '1'` returns a no-op Embedder (every call resolves to a zero vector and `MemorySearch` will skip the vector ranker). For tests + emergency fallback.
- Failure on load (e.g., ONNX init throws) caches the failure, logs once, and downgrades to no-op for the process lifetime. Does not crash the app.

## Storage

Migration 005 adds the vector table.

```sql
-- Extension is loaded in openDatabase() BEFORE runMigrations runs:
--   db.loadExtension(sqliteVec.getLoadablePath());
-- The extension must load successfully or the app cannot run; failure here
-- is fatal and surfaces via the existing 'Database open failed' dialog.

CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
  embedding float[384],
  +kind text,
  +ref_id text
);
CREATE INDEX IF NOT EXISTS memory_vec_ref_idx ON memory_vec(kind, ref_id);
```

The `+`-prefixed columns are auxiliary (stored, filterable in WHERE, not vector-indexed). One unified table keeps the SQL simple — `WHERE kind = 'fact'` to scope a search.

**Packaging:** `sqlite-vec` ships native binaries for darwin-{arm64,x64}, linux-{arm64,x64}, win32-x64. The npm package's `getLoadablePath()` returns the right one for the current platform. `electron-builder` unpacks the module so the binding can `dlopen` the loadable. Add a CI matrix smoke test that opens a DB and runs `SELECT vec_version()` on each target platform.

**No FK to fact/artifact:** vec0 virtual tables don't support FKs. Referential integrity is enforced in repo code (delete cascades). On `fact` or `artifact` archive (which is soft-delete via `archived = 1`), the vector stays — search filters by `archived = 0` via the join, so archived rows naturally drop out of results.

**Storage cost:** ~1.5 KB per row. 1000 rows ≈ 1.5 MB. Negligible.

## Repo integration

Both repos gain an `Embedder` constructor param (defaults to `getEmbedder()`; tests inject a stub).

### `FactRepo.upsert`

Becomes `async`. After the existing INSERT:

```ts
const vec = await this.embedder.embed(bodyTrimmed);
this.db.prepare(
  `INSERT INTO memory_vec(rowid, embedding, kind, ref_id)
   VALUES ((SELECT rowid FROM fact WHERE id = ?), ?, 'fact', ?)`
).run(id, Buffer.from(vec.buffer), id);
```

On dedup hit (existing row found by `body_norm`), skip — the existing vector is correct because the normalized body didn't change.

### `ArtifactRepo.upsert`

Becomes `async`. Embed `${title}\n${body}` so titles get strong signal (especially for short artifacts). On update, REPLACE the vector row (`DELETE memory_vec WHERE ref_id = ?` then INSERT) because the body or tags may have changed.

### Delete cascades

- `ArtifactRepo.delete(id)` and a new `FactRepo.delete(id)` both run `DELETE FROM memory_vec WHERE ref_id = ?` in the same transaction as the row delete.
- `FactRepo.delete` is exposed for the IPC `memory.delete` handler, which gains a fact-id branch (today only handles artifacts).
- The IPC contract for `memory.delete` already accepts an opaque `id`; the handler dispatches by checking which table owns the id (look up in `fact` first, then `artifact`).

### Caller updates

`upsert` becoming `async` propagates through:

- `src/main/reflection/pipeline.ts` — already in an async function; just `await`.
- `src/main/agent/sdk-client.ts` — the `knowledge_append` handler is already async.
- `src/main/index.ts` recall handler, IPC handlers — already async.
- `src/main/knowledge/import-legacy.ts` — already async; the for-loop body becomes `await repo.upsert(...)`.

No structural changes, just type/await propagation.

## Hybrid ranking

New module `src/main/memory/search.ts`:

```ts
export interface MemorySearchArgs {
  query: string;
  kinds?: Array<'fact' | 'playbook' | 'anti_pattern' | 'heuristic'>;
  limit: number;
}
export interface MemorySearchResult {
  facts: Fact[];
  artifacts: Artifact[];
}
export class MemorySearch {
  constructor(private deps: { factRepo: FactRepo; artifactRepo: ArtifactRepo; embedder: Embedder; db: Database });
  async search(args: MemorySearchArgs): Promise<MemorySearchResult>;
}
```

### Algorithm

Constants: `K_FTS = 30`, `K_VEC = 30`, `RRF_K = 60`.

1. **Decide which tables to query** based on `kinds`. Facts and artifacts go through the same fusion but are returned in separate buckets to match the existing `recall` tool surface.
2. **FTS ranker** — run the existing `fact_fts`/`artifact_fts` queries through `sanitizeFtsQuery`. Limit `K_FTS`. Yields ordered ids per kind.
3. **Vector ranker** — embed the query string once. For each requested kind, run:
   ```sql
   SELECT ref_id FROM memory_vec
    WHERE kind = ? AND embedding MATCH ? AND k = ?
    ORDER BY distance
   ```
   Yields ordered ids per kind.
4. **Fuse** — per kind, RRF over the two rank lists:
   ```
   score(id) = (1 / (RRF_K + fts_rank)) + (1 / (RRF_K + vec_rank))
   ```
   Items in only one ranker still score (just lower). Items in both win.
5. **Hydrate** — fetch the top `limit` rows per kind from `fact`/`artifact` by id. Bump use counts for facts (`factRepo.bumpUse(ids, 'recall')`) and artifacts (`artifactRepo.bumpUse(id)` per row, mirroring today's behavior).
6. **Return** — `{ facts, artifacts }` in score order per bucket.

### Failure handling

If `embedder.embed` rejects or returns a zero vector (the no-op signal from `OTTO_DISABLE_EMBEDDINGS=1` or an init failure), skip the vector ranker entirely and return FTS-only results. Log once per process at WARN level.

### Caller updates

- `src/main/index.ts` `recall:` arrow now constructs `MemorySearch` once at bootstrap and delegates:
  ```ts
  const memorySearch = new MemorySearch({ factRepo, artifactRepo, embedder, db });
  // ...
  recall: async (args) => memorySearch.search({ query: args.query, kinds: args.kinds, limit: Math.min(args.limit ?? 5, 20) }),
  ```
- `src/main/ipc/handlers.ts` `memory.list` handler delegates the search path to `memorySearch.search(...)` (when `query` is non-empty); the list-without-query path keeps using `repo.list({...})` directly.

## Bootstrap backfill

New module `src/main/embeddings/backfill.ts`:

```ts
export async function backfillEmbeddings(deps: {
  db: Database;
  factRepo: FactRepo;
  artifactRepo: ArtifactRepo;
  embedder: Embedder;
  logger: Logger;
}): Promise<{ embedded: number; ms: number }>;
```

Algorithm:

1. Find unembedded ids:
   ```sql
   SELECT id, body FROM fact
    WHERE id NOT IN (SELECT ref_id FROM memory_vec WHERE kind = 'fact')
   ```
   Same for each artifact kind, joining `title || char(10) || body` for embedding input.
2. Batch in groups of 32; call `embedder.embedBatch`.
3. Bulk INSERT into `memory_vec` per batch, inside a transaction.
4. Log `embedded N rows in Xms` at INFO.
5. Wrapped in try/catch — failure logs at ERROR and returns; FTS still works.

Idempotent: subsequent runs immediately return because the NOT IN clauses come up empty.

Called in `startElectron()` after migrations + repo construction, before SDK client construction:

```ts
const { backfillEmbeddings } = await import('./embeddings/backfill');
await backfillEmbeddings({ db, factRepo, artifactRepo, embedder: getEmbedder(), logger });
```

Estimated runtime on first run: ~1–2 seconds for a typical user (50 facts + 200 artifacts). Acceptable. The SDK isn't usable yet because the window hasn't opened; this is dead time from the user's perspective.

## Settings UI

None. The change is invisible. No knobs.

## Testing

New tests:

- **`src/main/embeddings/embedder.test.ts`** — singleton behavior, batch boundary (33 inputs → 2 batches), no-op fallback when `OTTO_DISABLE_EMBEDDINGS=1` (returns zero vector of correct dim), graceful failure when the model file is missing.
- **`src/main/embeddings/backfill.test.ts`** — seed unembedded rows, run backfill with a stub embedder that returns predictable vectors, assert `memory_vec` populated and a second run is a no-op.
- **`src/main/memory/search.test.ts`** — the meat:
  - Exact-keyword query hits via FTS even when the vector distance is large.
  - Paraphrase query hits via vector even when FTS misses (use a stub embedder whose vectors encode contrived synonyms).
  - Items in both rankers outscore items in one.
  - `kinds` filter excludes off-kind rows from both rankers.
  - Embedder failure (stub throws) returns FTS-only results.
  - Empty query returns empty result (no crash).

Updated tests:

- **`src/main/db/fact-repo.test.ts`** / **`src/main/db/artifact-repo.test.ts`** — pass a stub embedder via the new constructor arg. Add assertions:
  - `upsert` inserts a `memory_vec` row.
  - `delete` removes the `memory_vec` row.
  - `update` (artifact) replaces the `memory_vec` row.

The stub embedder returns `Float32Array.from({ length: 384 }, (_, i) => (text.charCodeAt(0) % 7 + i) * 0.001)` or similar — deterministic, no model load, fast.

## Non-goals (deferred)

- Re-embedding on body edits (no user-facing edit path exists).
- Multi-language embedding (English-only model is fine for v1).
- Query-side embedding cache (re-embed per call is ~5–15ms, fine).
- HNSW or other ANN indexing — `sqlite-vec`'s linear KNN is sub-millisecond at this scale.
- Replacing FTS entirely. RRF gets us the best of both for free.
- User-facing dial for "vector vs keyword weight" — RRF removes the need.

## Open risks

- **Bundle size:** the ONNX model adds ~22MB to the installer. Otto's current installer is small; this is the biggest single new asset. Acceptable but worth flagging in the release notes.
- **sqlite-vec extension portability:** the precompiled binaries cover the targets we care about (Linux, macOS, Windows x64/arm64). If a future target lacks a prebuilt, we'd need to fall back to FTS-only or compile in CI.
- **First-run latency:** model load + backfill add ~2 seconds to the first launch after upgrade. Most users won't notice (the window opens before the SDK is needed), but a slow disk could surface it.
- **Embedding quality:** MiniLM is good for general semantic similarity but isn't tuned for technical jargon (kdotool, pipewire, etc.). Real-world recall quality may surprise us in either direction. We'll evaluate after a few weeks of use; if it underperforms, swapping to bge-small or a domain-finetuned model is a one-file change.
