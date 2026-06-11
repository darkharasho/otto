# Memory/Recall Polish + Wayland Cursor Fix + Screenshot RAM Fix

**Date:** 2026-06-10
**Status:** Approved (user selected all three work items)

## Problems

The memory system (SQLite + FTS5 + sqlite-vec hybrid RRF search, Haiku reflection,
decay-based pinning) is structurally sound but has quality gaps that compound over
months of use:

1. **Paraphrase duplicates.** Fact dedup is exact-normalized-text only; artifact dedup
   is case-insensitive title match. Semantically identical memories accumulate as
   separate rows, splitting use counts and diluting search.
2. **Recall ranking ignores value.** RRF fuses FTS+vector rank, but a fact used in 10
   sessions ranks identically to cold noise matching the same words. The maintained
   `distinct_sessions × decay` score is used only for pinning.
3. **Recall bump pollution.** Appearing in recall results bumps `use_count` and inserts
   a fake `'recall'` session row — merely being returned counts as being useful.
4. **No staleness lifecycle for facts.** Outdated facts stay searchable forever; decay
   only affects pin order. (Artifacts already have `archived`.)
5. **Lossy FTS sanitization.** Operator characters (including hyphens) are stripped,
   so "multi-monitor" degrades to two independent prefix terms.
6. **No provenance.** Recall returns bare fact text; the model cannot weigh "learned
   yesterday, reused 12 times" against "learned 6 months ago, never used since."

Separately: `get_cursor_position` still reads Electron's `screen.getCursorScreenPoint`,
which freezes/lies on Wayland outside Electron surfaces; and the documented ~20GB RAM
issue (screenshot bytes retained in renderer/main memory) remains open.

## Design

### 1. FTS quoting instead of stripping (`src/main/db/fts-utils.ts`)

Tokenize on whitespace, strip embedded double quotes, drop tokens with no
letters/digits, emit each token as a quoted prefix phrase: `"multi-monitor"*`.
Hyphenated/punctuated terms become adjacency phrases (higher precision) instead of
being split into independent terms. Pure function, unit-tested without sqlite.

### 2. Fact archival (migration 007 + `fact-repo.ts`)

- `ALTER TABLE fact ADD COLUMN archived INTEGER NOT NULL DEFAULT 0` + index.
- `rerank()` additionally archives facts that are unpinned AND unused for 180 days
  (`last_used_at ?? created_at`); archived facts are excluded from pinning candidates,
  FTS search, and recall results.
- Re-learning a fact (dedup hit on upsert) un-archives it. Nothing is deleted.

### 3. Honest usage signals (`fact-repo.ts`, `memory/search.ts`)

- `bumpUse(ids, sessionId)` keeps its meaning — *the fact was placed in front of the
  model* (pinned-prompt injection) or *independently re-learned*.
- New `bumpRecall(ids)`: `use_count + 1` and `last_used_at = now` only — no
  `distinct_sessions`, no fake `'recall'` session row. MemorySearch switches to it.
- Fact upsert dedup hits now count as re-learning: bump `distinct_sessions` via the
  real `sourceSessionId`, refresh `last_used_at`, clear `archived`. Independent
  rediscovery across sessions is the strongest pin signal there is.

### 4. Semantic dedup at write time (`fact-repo.ts`, `artifact-repo.ts`)

When exact/title dedup misses and the embedder is available:

- Embed the candidate; KNN `memory_vec` (fetch wide, filter by kind app-side, same
  pattern as search). Convert L2 distance on unit vectors to cosine
  (`cos = 1 − d²/2`).
- **Facts:** cosine ≥ 0.90 → treat as the existing fact (re-learn semantics above);
  keep the existing body. Returns `{ id, inserted: false }`.
- **Artifacts:** cosine ≥ 0.85 → update that artifact in place with the newer
  title/body/tags (reflection output is fresher), re-embed.
- Embedder unavailable → behavior unchanged (exact/title dedup only).

### 5. Value-aware recall ranking (`memory/search.ts`)

After RRF fusion, boost candidates by their stored value signals before final sort:

- Facts: `final = rrf × (1 + 0.25 × ln(1 + fact.score))` — `fact.score` is the
  maintained `distinct_sessions × exp(−age/21d)`.
- Artifacts: `final = rrf × (1 + 0.15 × ln(1 + use_count))`.

Multiplicative-with-log keeps text relevance dominant; value breaks ties and floats
proven memories. Constants exported for tests.

### 6. Provenance in recall results (`index.ts` recall mapping, tool description)

Facts return as objects: `{ body, learned_at (ISO), last_used_at (ISO|null),
times_used, sessions_seen }`. Artifacts gain `use_count` and `last_used_at`. The
`recall` tool description tells the model these fields exist and to weigh
old-and-never-reused memories skeptically.

### 7. Wayland cursor position (`input/portal.ts`, `platform/linux.ts`)

`InputHandle` gains `position(): { x, y } | null` returning the portal's tracked
cursor (`lastSentCursor`). `LinuxAdapter.input.cursorPosition()` prefers it and falls
back to Electron's read when the portal hasn't moved the pointer yet. The tracked
value is where Otto last *placed* the pointer — exactly the question the agent is
asking; the Electron read is a frozen phantom outside Electron surfaces on Wayland.
Tool description documents the semantics.

### 8. Screenshot RAM retention (separate exploration + fix)

Scoped after exploration of the renderer store and main-process history; the known
shape (memory note + image-ref architecture doc): renderer must hold image-refs (id +
path) and load bytes on demand, never retain decoded/base64 bytes in the store; main
process must not keep base64 screenshot payloads alive in its own history structures.
Implemented as far as tractable in this pass; SDK-internal history retention is
documented if it can't be fixed from Otto's side.

## Out of scope

- Reflection prompt/quality changes, RRF constant tuning/eval harness, embedding
  model upgrades, re-embed-on-model-change, memory management UI.

## Testing

- `fts-utils`: pure unit tests (quoting, operator stripping, empty cases).
- `fact-repo`: archival in rerank (>180d unpinned), un-archive on re-learn, dedup
  bump of distinct_sessions with real session id, bumpRecall not touching
  distinct_sessions, semantic-dup threshold behavior (fake embedder).
- `artifact-repo`: semantic upsert-merge with fake embedder.
- `memory/search`: value boost ordering, archived facts excluded, bumpRecall used.
- DB-backed tests currently fail locally on a better-sqlite3 ABI mismatch
  (NODE_MODULE_VERSION 130 vs 137) — pre-existing; verify via rebuild or CI.
