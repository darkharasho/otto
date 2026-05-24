# Knowledge pin/learn split — design

Date: 2026-05-24
Status: Draft (pending user review)

## Problem

Otto's persistent memory currently has two tiers:

- **Facts** — appended lines in `~/.../knowledge.md`, **read in full into the system prompt every turn**. Dedup is a normalized-string compare in `src/main/knowledge/dedup.ts`. No per-fact counters, no eviction.
- **Artifacts** (playbooks, anti-patterns, heuristics) — SQLite `artifact` table with FTS5, capped at 500 per kind, fetched lazily via the `recall` tool. Per-row `use_count` + `last_used_at` already exist.

The artifact path scales fine. The fact path does not: `knowledge.md` grows unbounded and is sent every turn, so per-turn prompt cost rises linearly with everything Otto has ever learned. As the user's machine accumulates months of usage, this becomes the dominant memory cost.

## Goal

Bound the always-loaded fact set with a small, score-ranked, self-managing pinned subset. Everything else becomes recall-on-demand. The split must be invisible to the user — they continue to perceive Otto as "remembering stuff"; the system decides what stays hot.

Embedding-based recall is a follow-up; this spec is keyword/FTS only, matching the current artifact path.

## Design summary

- Facts move from `knowledge.md` into a SQLite `fact` table with the same FTS5 + counters pattern as `artifact`.
- Each fact has a recency-weighted `score = distinct_sessions * exp(-age_days / 21)`.
- A bounded **pinned** subset (top `N=40` by score) is loaded into the system prompt every turn. The rest are **learned** — still queryable via the `recall` tool, but not always-on.
- Promotion: learned facts with `distinct_sessions >= 3` become candidates; election happens at re-rank.
- Eviction: after every reflection cycle, scores are recomputed and the top 40 take the pinned slots. Demoted facts stay in the table and remain recallable.
- The reflector tags new facts with an optional `preference: true` flag. Preference facts enter with `distinct_sessions = 2` so a single subsequent use promotes them.
- `knowledge.md` becomes a regenerated, read-only projection of currently-pinned facts (for human inspection). The DB is source of truth.

## Data model

New tables, added via DB migration in `src/main/db/db.ts`:

```sql
CREATE TABLE fact (
  id                 TEXT PRIMARY KEY,
  body               TEXT NOT NULL,
  body_norm          TEXT NOT NULL,
  pinned             INTEGER NOT NULL DEFAULT 0,
  use_count          INTEGER NOT NULL DEFAULT 0,
  distinct_sessions  INTEGER NOT NULL DEFAULT 0,
  score              REAL    NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  last_used_at       INTEGER,
  source_session_id  TEXT
);
CREATE UNIQUE INDEX fact_body_norm_idx ON fact(body_norm);

CREATE TABLE fact_session (
  fact_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (fact_id, session_id)
);

-- FTS5 mirror, mirroring the existing artifact_fts pattern
CREATE VIRTUAL TABLE fact_fts USING fts5(body, content='fact', content_rowid='rowid');
-- + standard insert/update/delete triggers to keep fact_fts in sync
```

Notes:

- `body_norm` reuses the normalization logic in `src/main/knowledge/dedup.ts` — moved or shared, not duplicated.
- `score` is denormalized so `listPinned()` and the re-rank query are simple ORDER BYs. It's recomputed on every `rerank()` call.
- `distinct_sessions` is denormalized from `fact_session` for fast scoring; it's incremented when a `fact_session` row is newly inserted.

## Scoring, promotion, eviction

**Score formula** (computed in JS, written to `score` column on re-rank):

```
age_days = (now - (last_used_at ?? created_at)) / 86_400_000
score    = distinct_sessions * exp(-age_days / 21)
```

**Promotion**: at re-rank, any learned fact with `distinct_sessions >= 3` competes for a pinned slot. Election is purely by score: take top `N=40` across **all** facts (pinned + learned) as the new pinned set.

**Eviction**: facts that fall out of the top 40 at re-rank are demoted (`pinned = 0`). They remain in the table and queryable via `recall`.

**Re-rank cadence**: once per reflection cycle, at the end of `ReflectionPipeline.run`, after fact upserts.

**`bumpUse(factIds, sessionId)`**:

- Increment `use_count`.
- Set `last_used_at = now`.
- `INSERT OR IGNORE` into `fact_session`; if a row was actually inserted, increment `distinct_sessions`.

Called in two places:

1. The `recall` tool — when a fact appears in results.
2. `sdk-client` turn start — for every fact in `listPinned()` that gets loaded into the system prompt.

Counting "pinned loaded into prompt" as a use is intentional: it lets pinned facts hold their slot by virtue of being relevant enough to ship every turn. If the agent stops using a pinned fact, its score still decays with age because `last_used_at` keeps moving — so a fact that's loaded but ignored eventually loses to a fact that's actively recalled. (Decay applies to all facts uniformly; pinned facts get a small advantage from being loaded, but that advantage is the same for all of them.)

**Tunable knobs** (constants in code, no UI):

- `PINNED_BUDGET = 40`
- `SCORE_HALF_LIFE_DAYS = 21`
- `PROMOTION_THRESHOLD = 3` (distinct sessions)
- `BOOTSTRAP_PREFERENCE_SESSIONS = 2`

## Components & data flow

### New / changed modules

- **`src/main/db/fact-repo.ts`** (new) — `FactRepo` with:
  - `upsert({ body, sourceSessionId, preference })` — dedup on `body_norm`; on insert, sets `distinct_sessions = preference ? 2 : 0`. On dedup hit, returns existing id without bumping anything.
  - `search({ query, limit })` — FTS5, sanitized like `sanitizeFtsQuery` in `artifact-repo.ts`.
  - `listPinned()` — `SELECT * FROM fact WHERE pinned = 1 ORDER BY score DESC`.
  - `bumpUse(factIds: string[], sessionId: string)` — single transaction.
  - `rerank()` — recompute all scores, set top N to `pinned = 1`, rest to `pinned = 0`, return `{ promoted: string[], demoted: string[] }`.
  - `counts()` — `{ pinned, total }`.
  - `list({ limit, includeUnpinned })` — for the Settings UI's "Browse Otto's memory" list.

- **`src/main/db/db.ts`** — migration:
  1. Create `fact`, `fact_session`, `fact_fts` + triggers.
  2. If `configDir/knowledge.md` exists, parse each line. Lines matching `- (YYYY-MM-DD) <body>` import with `created_at` = parsed date (midnight UTC). Lines not matching the bullet pattern import with `created_at = now`. All imported facts get `pinned = 1`, `distinct_sessions = 0`.
  3. Rename `knowledge.md` → `knowledge.md.pre-split.bak`.
  4. Run `rerank()` once. With all imported facts at `distinct_sessions = 0`, score is 0; tie-break by `created_at DESC`. If the user had >40 facts, only the 40 newest stay pinned; the rest become learned but recallable.

- **`src/main/knowledge/store.ts`** — `appendKnowledge` is removed. `readKnowledge` is replaced by a function that renders pinned facts as markdown for inclusion in the system prompt. A new `regenerateKnowledgeFile(configDir, factRepo)` writes the projection to `knowledge.md` (with an `<!-- auto-generated; edits will be overwritten -->` header) after any change that affects pinned. The system prompt reads facts from `FactRepo.listPinned()` directly — the file is for human inspection only.

- **`src/main/knowledge/dedup.ts`** — keep the normalization helper. `filterNovelFacts` becomes `isNovelFact(repo, body)` (or returns an array of novel bodies) using `FactRepo` instead of scanning markdown.

- **`src/main/reflection/schema.ts`** — change `facts` from `string[]` to `Array<{ body: string; preference?: boolean }>`. Same limits apply (max 20, body ≤ 280 chars).

- **`src/main/reflection/prompt.ts`** — instruct the reflector: "For each fact, set `preference: true` when the fact is a stable user or machine preference (a tool of choice, an always-do/never-do rule, a hardware constraint). Set false or omit otherwise."

- **`src/main/reflection/pipeline.ts`** — fact handling becomes:
  1. For each emitted fact: dedup via `FactRepo.isNovel(body)`; if novel, `FactRepo.upsert({ body, sourceSessionId, preference })`.
  2. After all writes, call `FactRepo.rerank()`.
  3. Memory-update system note gains `{ promoted, demoted, pinned_total }`.

- **`src/main/agent/tools.ts`** — `recall` tool's fact branch hits `FactRepo.search` instead of scanning `knowledge.md`. On hits, calls `FactRepo.bumpUse(ids, sessionId)`.

- **`src/main/agent/sdk-client.ts`** — at turn start:
  1. Load pinned facts via `FactRepo.listPinned()`.
  2. Render into system prompt where `readKnowledge` was previously inlined.
  3. Call `FactRepo.bumpUse(pinnedIds, sessionId)`.

### Per-turn data flow

1. Turn start → `listPinned()` → injected into system prompt → `bumpUse(pinnedIds, sessionId)`.
2. Mid-turn `recall` calls → FTS search across facts + artifacts → `bumpUse` on fact hits.
3. End-of-session reflection → reflector emits facts with optional `preference` → `upsert` → `rerank()` → memory-update note logs `{ promoted, demoted, pinned_total }`.

## Migration

One-shot, on first launch after upgrade. See the `db.ts` migration steps above. The `.bak` file is kept indefinitely; we do not garbage-collect it. Migration is idempotent against missing source (`knowledge.md` absent → just creates tables).

## Settings UI

`src/renderer/components/settings/MemorySection.tsx`:

- Remove the "Edit knowledge.md…" affordance — the file is no longer the source of truth.
- Add a read-only "Browse Otto's memory" list: each row shows fact body, a pinned badge if `pinned = 1`, `use_count`, and a relative `last_used_at`. Paginated or virtualized if total > a few hundred (likely not initially).
- Section header counts: show `facts (pinned/total)` and unchanged artifact counts.
- No manual pin/unpin controls. No threshold knobs. Full automation is the design.

## Testing

- **`fact-repo.test.ts`** — upsert + dedup, FTS search sanitization, `bumpUse` increments `use_count`/`last_used_at` and `distinct_sessions` only on first session, `rerank()` correctly elects top-N at the budget boundary and returns promoted/demoted IDs, score formula matches expected values at known timestamps.
- **`pipeline.test.ts`** — updated assertions: facts go through `FactRepo` not markdown; `preference: true` bootstraps `distinct_sessions = 2`; `rerank` is invoked after writes; memory-update note includes promoted/demoted counts.
- **`dedup.test.ts`** — updated to use repo-backed novelty check.
- **`db.test.ts`** — migration with a fixture `knowledge.md` produces expected rows; non-matching lines still import with `created_at = now`; `.bak` is written.
- **`tools.test.ts`** — `recall` fact branch hits the repo and bumps use; session id is threaded through.
- **`sdk-client`** — verify turn start loads pinned facts and bumps them with the current session id. Use the existing test surface for `sdk-client` if one exists; otherwise add a focused unit test on the seam.

## Non-goals (deferred)

- Embedding-based recall — own spec, comes next.
- User-facing pin/unpin controls.
- Reflector re-classification of pre-existing facts beyond the import path.
- Round-trip parsing of user edits to `knowledge.md` (the file is a projection only).
- Telemetry pipeline for tuning knobs (start with hardcoded constants; tune from log inspection).

## Open risks

- **Self-reinforcing pinned set**: bumping use on every prompt load keeps pinned facts looking active even if the agent never references them. Mitigation: scoring decays uniformly with `last_used_at`, so a fact that no longer recalls keeps its base score but doesn't gain; over time, more-recalled facts from the learned tier overtake it. Acceptable for v1; revisit with telemetry.
- **Cold-start ranking after migration**: all imported facts tied at `distinct_sessions = 0`. Tie-break by `created_at` is good enough but means the first few sessions can churn the pinned set. Acceptable.
- **Re-rank cost**: linear in `total_facts`, runs once per reflection. Trivial up to thousands of rows. If total grows past that we add an index-supported partial re-rank later.
