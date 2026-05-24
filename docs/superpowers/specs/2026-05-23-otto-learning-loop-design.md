# Otto Learning Loop — Design

**Date:** 2026-05-23
**Status:** Draft for implementation

## Goal

After Otto finishes a task, reflect on the interaction in the background and persist what it learned so future tasks benefit. Otto becomes incrementally smarter at this machine's quirks, the user's preferences, and recurring procedures, with no user effort beyond optional curation.

## Non-goals

- Cloud sync of memory.
- Cross-machine learning.
- Embeddings / semantic retrieval in v1 (FTS5 keyword search is sufficient).
- Auto-execution of stored playbooks (Otto reads them as guidance; the user still triggers any action through the existing tool autonomy gates).
- Approval prompts for new artifacts (per user choice — fully autonomous, view-only browser with edit/archive after the fact).

## Architecture overview

Four pieces:

1. **Completion detector** in `SessionManager` — fires once per task when the user is idle after a `done` event, or when Otto explicitly calls `mark_task_complete`.
2. **Reflector** — a separate, single-turn Claude SDK call (fresh session, cheaper model) that reads the just-finished transcript and emits structured JSON artifacts.
3. **Memory store** — facts append to the existing `knowledge.md`; playbooks / anti-patterns / heuristics live in a new SQLite `artifact` table with FTS5.
4. **`recall` tool** — an agent-facing read-class tool that searches the store; called by Otto at the start of tasks that resemble past work.

Plus a **Memory** tab in the settings window for browsing, editing, archiving, and deleting.

## Section 1 — Completion detection

Two complementary signals, whichever fires first triggers reflection:

- **Idle timeout after `done`.** When `SessionManager` emits a `done` event and no new user message arrives within 90 seconds (tunable via settings), the task is treated as complete.
- **Explicit `mark_task_complete(summary: string)` tool.** A new no-op tool Otto can call when it believes the user's request is fully addressed. Tagged `read` (always allowed). Calling it short-circuits the timeout and triggers reflection immediately.

**Guard state per session:**

- `reflectionPending: boolean` — true between trigger fire and reflector completion.
- `lastReflectionMessageIndex: number` — index of the last message included in the most recent reflection; the next reflection's slice starts after this.

If the user sends a new message while the idle timer is running, the timer is cancelled and the task window extends. If the user sends a new message while `reflectionPending` is true, the new turn proceeds normally; the in-flight reflection completes against its snapshot and is the last reflection for the previous window.

App quit during the idle window: pending reflection is lost. Acceptable for v1.

## Section 2 — Reflector subagent

Lives in `src/main/reflection/reflector.ts`.

**Mechanics:**

- Reuses the existing `SdkClient`. Starts a **fresh session** (no `resume`) so reflection does not pollute the working session.
- Default model: `claude-haiku-4-5-20251001`. Overridable via a new `reflectionModel` setting.
- 60-second hard timeout. No retries.

**Prompt inputs:**

- The user's original request (first user message of the slice).
- The trimmed transcript slice — user messages, assistant text, tool calls, tool results — from `lastReflectionMessageIndex + 1` to "now". Tool-result content past a ~30k-token budget is truncated with `[…elided…]` markers; user/assistant text is kept whole.
- The current contents of `knowledge.md` for fact-dedup.
- The list of existing non-archived artifact titles + kinds + tags for playbook/anti-pattern/heuristic dedup.
- Strict JSON output schema (below).

**Output schema (Zod-validated):**

```ts
{
  facts: string[],                   // short standalone notes; appended to knowledge.md
  playbooks: Array<{
    title: string,
    body: string,                    // markdown, conventional "When to use / Steps / Notes" structure
    tags: string[]
  }>,
  antiPatterns: Array<{
    title: string,
    body: string,
    tags: string[]
  }>,
  heuristics: Array<{
    title: string,
    body: string,
    tags: string[]
  }>,
  skip_reason?: string               // reflector may explain why nothing was saved
}
```

The prompt explicitly encourages empty arrays — most short tasks yield nothing worth saving. Reflector is told to never store secrets / tokens / credentials seen in tool output and to treat `redacted`/`****` patterns as unsavable.

**Concurrency:** at most one reflection in flight per session. A second completion signal during reflection is ignored.

## Section 3 — Artifact schema & storage

### `knowledge.md` (unchanged location and format)

Facts append as new lines using the existing shape:

```
- (YYYY-MM-DD) <fact>
```

Before appending, the reflector pipeline filters out facts whose normalized text (lowercased, whitespace-collapsed) already appears in the current file.

### SQLite (new migration)

```sql
CREATE TABLE artifact (
  id                 TEXT PRIMARY KEY,         -- uuid
  kind               TEXT NOT NULL,            -- 'playbook' | 'anti_pattern' | 'heuristic'
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,            -- markdown
  tags               TEXT NOT NULL,            -- json array of strings (lowercased keywords)
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  source_session_id  TEXT,
  use_count          INTEGER NOT NULL DEFAULT 0,
  last_used_at       INTEGER,
  archived           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX artifact_kind_idx ON artifact(kind);
CREATE INDEX artifact_archived_idx ON artifact(archived);

CREATE VIRTUAL TABLE artifact_fts USING fts5(
  title, body, tags,
  content='artifact',
  content_rowid='rowid'
);

-- triggers (INSERT / UPDATE / DELETE on artifact) keep artifact_fts in sync
```

### Playbook body convention (markdown, not schema-enforced)

```
## When to use
<one-paragraph trigger description>

## Steps
1. ...
2. ...

## Notes
- caveats, prerequisites, known failure modes
```

### Dedup / update on insert

For each artifact the reflector returns:

- If `kind`+`title` (case-insensitive) matches an existing non-archived row → update `body`, `tags`, `updated_at`, `source_session_id`; leave `use_count` and `last_used_at` alone.
- Otherwise → insert new row.

### Hygiene

- Soft cap warning: artifacts with `use_count == 0` and `created_at > 30 days ago` get a "stale" badge in the browser. No auto-deletion.
- Hard cap: 500 artifacts per kind. Past that, the reflector pipeline refuses to insert new ones until the user archives some, and emits a one-time tray notification: *"Otto's memory is full — open Memory to prune."*

## Section 4 — The `recall` tool

Registered in `src/main/agent/tools.ts` alongside existing tools.

```ts
recall({
  query: string,
  kinds?: Array<'fact' | 'playbook' | 'anti_pattern' | 'heuristic'>,
  limit?: number    // default 5, max 20
}) => {
  facts: string[],
  artifacts: Array<{
    id: string,
    kind: string,
    title: string,
    body: string,
    tags: string[],
    updated_at: number
  }>
}
```

**Behavior:**

- Autonomy class: `read`. Always allowed in every mode, no confirmation prompt.
- FTS5 `MATCH` against `artifact_fts` with a sanitized query (strip FTS operators, fall back to space-separated prefix tokens: `tok*`). Filter by `kind ∈ kinds` (if provided) and `archived = 0`. Order by FTS rank.
- For `fact` results (when `'fact'` is in `kinds` or `kinds` is omitted), scan `knowledge.md` line by line, case-insensitive substring match against any query token, return up to `limit` hits.
- Side effects: every returned artifact has `use_count += 1` and `last_used_at = now`.
- Returns empty arrays freely. Otto's system prompt covers the "no memory matches" case.

**System-prompt addition** (where the agent prelude is assembled in `sdk-client.ts` or equivalent):

> *You have a `recall` tool that searches durable memory accumulated from prior sessions on this machine. Call it at the start of any task that resembles past work — fixing a recurring problem, automating a familiar app, dealing with this machine's known quirks — before deciding on an approach.*
>
> *Memory currently holds N playbooks, M anti-patterns, K heuristics.*

The counts are computed by a cheap `SELECT COUNT(*) GROUP BY kind` at the start of each turn.

## Section 5 — Memory browser UI

A new **Memory** tab in the existing settings window.

**Layout:**

- Sub-tabs across the top: `Facts` · `Playbooks` · `Anti-patterns` · `Heuristics`, each with a count badge.
- Search box above the list filters via the same FTS path as `recall` (without the `use_count` side effect).
- List rows: title (or first line for facts), tag chips, last-used relative time ("used 3 days ago"), and a kebab menu — *Edit*, *Archive*, *Delete*.
- Edit modal: plain markdown textarea on `body` plus editable tag chips. For facts, opens the full `knowledge.md` text in a textarea — same UX as if the user opened the file themselves, just inside Otto.
- Archive sets `archived = 1` (hidden from `recall`, kept in history). Delete is permanent and prompts for confirmation.
- No live updates — list pulls on tab open / search / explicit refresh.

**New IPC (in `src/shared/ipc-contract.ts`):**

- `memory:list({ kind, query?, includeArchived? })` → rows
- `memory:get(id)` → row
- `memory:update(id, { title?, body?, tags?, archived? })`
- `memory:delete(id)`
- `memory:readFacts()` / `memory:writeFacts(text)`

**Discoverability:** when reflection saves at least one artifact, the main process emits a single small tray notification *"Otto learned N new things — open Memory"*. Clicking opens the settings window on the Memory tab. One notification per reflection, never coalesced or repeated.

## Section 6 — Error handling, edge cases, privacy

**Reflector failures (silent, never user-visible):**

- SDK error or 60s timeout → log at `error`, drop, no artifacts written, no notification.
- JSON parse or Zod validation failure → log raw output at `debug`, drop.
- DB write failure → log at `error`; main-process log only.

**Completion-detection edge cases:**

- New user message during the 90s idle window → cancel timer, extend task.
- New user message while reflection is in flight → new turn proceeds normally; reflection completes against its snapshot.
- `mark_task_complete` called more than once in one window → second+ calls are no-ops.
- App quit during idle window → pending reflection is lost (no persistence of pending state in v1).

**Privacy / safety:**

- Reflector input is the same content the main agent already saw — no new data egress surface.
- Reflector prompt explicitly forbids storing secrets, tokens, passwords, and `redacted`/`****`-shaped strings.
- Memory store lives in Otto's existing `configDir` alongside `knowledge.md` and the main SQLite DB. Local only, never synced.

**Autonomy interaction:** memory writes are a system-internal pipeline, not an Otto-issued tool call, so they bypass the autonomy gate. `recall` is `read`-class. The browser gives the user full delete/archive control after the fact, which is the curation surface the user chose.

## Section 7 — Testing

- **Unit:**
  - Zod schema accepts/rejects reflector outputs.
  - Repo CRUD + FTS search + dedup-by-(kind,title).
  - Idle-timer logic with fake timers (start, cancel on new message, fire on timeout, no double-fire).
  - `knowledge.md` dedup against existing lines.
  - Query sanitizer (strip FTS operators, prefix-token fallback).
- **Integration:**
  - In-memory SQLite + stub `SdkClient` that emits scripted reflector JSON responses.
  - Assert artifacts land correctly; `use_count` bumps on `recall`; archived rows are excluded from `recall`; dedup updates rather than inserts.
- **Renderer:**
  - Memory browser smoke tests (list, search, edit, archive) with mocked IPC.
- **Not in scope:**
  - End-to-end tests of LLM reflection quality. A `scripts/eval-reflector.ts` runs the prompt against a few canned transcripts and prints output for ad-hoc dev checks.

## Files added / changed

**New:**

- `src/main/reflection/reflector.ts` — prompt, SDK call, JSON parse/validate.
- `src/main/reflection/completion-detector.ts` — idle-timer + `mark_task_complete` handling.
- `src/main/reflection/pipeline.ts` — orchestrates reflector → dedup → store writes → tray notification.
- `src/main/db/artifact-repo.ts` — CRUD + FTS query helpers.
- `src/renderer/components/MemoryPanel/*` — settings tab UI.
- `scripts/eval-reflector.ts` — dev-only canned-transcript runner.

**Changed:**

- `src/main/db/db.ts` — new migration for `artifact` + `artifact_fts` + triggers.
- `src/main/agent/session.ts` — emit completion signals; wire to detector.
- `src/main/agent/tools.ts` — register `recall` and `mark_task_complete`.
- `src/main/agent/sdk-client.ts` (or wherever the system prompt is assembled) — add the recall guidance paragraph + per-turn memory counts.
- `src/shared/ipc-contract.ts` — new `memory:*` channels.
- `src/main/ipc/*` — handlers for the new channels.
- `src/renderer/SettingsApp.tsx` — add Memory tab.
- `src/main/tray.ts` — "Otto learned N new things" notification + click handler.

## Open questions deferred to implementation

- Exact reflector prompt wording — iterate against `scripts/eval-reflector.ts` output.
- Whether the 90s idle timeout should be user-configurable in the settings UI or just a constant for v1. (Default: constant, revisit after dogfooding.)
