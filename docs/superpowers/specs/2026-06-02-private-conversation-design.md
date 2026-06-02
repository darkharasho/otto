# Private Conversations (`/p`) — Design

**Date:** 2026-06-02
**Status:** Approved (pending spec review)

## Summary

Add a `/p ` command bar prefix that starts a **private conversation**, mirroring
the existing `/n ` (new conversation) behavior but with one guarantee: **nothing
the conversation does touches durable storage.** A private conversation:

1. **Skips reflection** — the `CompletionDetector` / `ReflectionPipeline` never
   learn facts, playbooks, anti-patterns, or heuristics from it.
2. **Blocks in-session memory writes** — the agent's `knowledge_append` tool
   no-ops, and per-session fact-usage bookkeeping (`bumpFactUse`) is suppressed.
3. **Is ephemeral** — the session and its messages are never written to SQLite,
   so it never appears in history/the sidebar and leaves no on-disk residue.

Reading durable memory (`recall`, pinned facts injected into the system prompt)
stays enabled — "private" constrains writes and persistence, not reads.

There is **no visual badge** (the conversation simply isn't persisted and won't
show in history).

## Architecture

The single source of truth for "is this session private?" is a
`PrivacyAwareRepo` decorator wrapping the existing `Repo`. It owns an in-memory
store keyed by private session id and exposes `isPrivate(id)`.

```
renderer (/p prefix)
  └─ session.start { private: true }
       └─ SessionManager.start
            └─ repo.createSession({ ..., private: true })   ← PrivacyAwareRepo registers id
                                                              and routes all I/O for it to memory

reflection gate:    onTrigger → if repo.isPrivate(sessionId) return        (skip pipeline)
memory-write gate:  appendKnowledge / bumpFactUse → if repo.isPrivate(id) no-op
```

### Components

**1. `PrivacyAwareRepo` (new) — `src/main/db/privacy-aware-repo.ts`**
A decorator implementing the same surface `SessionManager` and the reflection
pipeline use from `Repo`. It holds:
- `private: Set<string>` of private session ids
- an in-memory `Map<sessionId, { meta: SessionMeta; messages: Message[] }>`

Behavior, dispatched by whether the session id is private:
- `createSession(args)` — if `args.private`, register the id and create the
  in-memory meta; otherwise delegate to disk.
- `appendMessage`, `setSdkSessionId`, `setSessionTitleIfMissing`,
  `updateSessionActivity` — private id → mutate in-memory entry; else delegate.
- `getSession`, `loadMessages` — private id → read from memory; else delegate.
- `listSessions` — delegate only (private sessions are intentionally absent, so
  they never appear in history).
- `isPrivate(id): boolean` — membership test.
- `dropPrivate(id): void` — free the in-memory entry (called on session close).

`CreateSessionArgs` gains an optional `private?: boolean`. The base `Repo`
ignores it (private sessions never reach the base repo's `createSession`).

Because every existing call site already goes through `repo`, `SessionManager`
needs no per-call `if (private)` branches.

**2. Manual prefix — `src/shared/manual-prefix.ts`**
Add `PRIVATE_CONVERSATION_PREFIX = '/p '` and
`parsePrivateConversationPrefix(buffer)`, symmetric to the existing
new-conversation helpers.

**3. `CommandBar` — `src/renderer/components/CommandBar.tsx`**
Add an `onPrivateConversation` prop. In `handleSubmit` and the `onChange`
type-the-prefix-and-fire-immediately path, handle `/p ` exactly as `/n ` is
handled today, calling `onPrivateConversation` instead of `onNewConversation`.

**4. `App.tsx` — `src/renderer/App.tsx`**
Add `handlePrivateConversation`, a near-copy of `handleNewConversation`:
- **With text (`/p fix my audio`):** close the old session, call
  `ipc.invoke('session.start', { model, private: true })`, send the message. It
  does **not** refresh `session.list` (a private session must not surface in
  history).
- **Empty trigger (`/p ` then space, mirroring the `/n ` muscle-memory case):**
  abandon the active session, collapse to the bar, and set a renderer
  `pendingPrivate` flag (React ref/state). The next submit goes through
  `ensureSession`, which must propagate this flag so the lazily-created session
  is private (see component 5 below). The flag is cleared once consumed.

Wire the new prop into every `CommandBar`/`ChatWindow` render site alongside
`onNewConversation`. (Optional, deferred: a Cmd/Ctrl+Shift+P keyboard shortcut —
out of scope for v1.)

**5. IPC contract — `src/shared/ipc-contract.ts`**
`SessionStartArgs` gains `private?: boolean`. `SessionEnsureForSubmitArgs` (the
`session.ensureForSubmit` request) also gains `private?: boolean`, so the
empty-trigger arming case can create a private session lazily on the next submit.
`ensureSession` in `App.tsx` reads and clears the `pendingPrivate` flag and
passes it through. The `session.ensureForSubmit` main handler threads it into
`SessionManager.start({ ..., private })` when it creates a new session.

**6. Main wiring — `src/main/index.ts`**
- Wrap the real `Repo` in `PrivacyAwareRepo`; pass the wrapper everywhere `repo`
  is used today (SessionManager, ReflectionPipeline deps, IPC handlers).
- Reflection gate: `ReflectionPipeline` gains an `isPrivate(sessionId)` dep;
  `run()` returns a skipped result (`reason: 'private'`) before loading messages.
  This is the single chokepoint for every trigger path (idle, turn-count, and
  `mark_task_complete` all route through `pipeline.run`). The gate must live in
  the pipeline, not rely on an empty transcript — `PrivacyAwareRepo.loadMessages`
  returns the in-memory private messages, so without the gate they'd be reflected
  on.
- Memory-write gates in the `createRealSdkClient` deps:
  - `appendKnowledge(note, sessionId)` → if `repo.isPrivate(sessionId)`, return
    without writing (the tool still reports "noted" to the model so it isn't
    confused).
  - `bumpFactUse(ids, sessionId)` → if `repo.isPrivate(sessionId)`, no-op (avoids
    recording the private session in `fact_session` / use counts).
- In the `session.close` IPC handler, after `await sessions.close(args)`, call
  `repo.dropPrivate(args.sessionId)` to free memory (`SessionManager` stays
  privacy-unaware; `dropPrivate` is a no-op for non-private ids).

**7. `SessionManager.start` — `src/main/agent/session.ts`**
`start` already accepts `{ resume?, model? }`. Add `private?: boolean`, threaded
into `repo.createSession({ ..., private: args.private })`. The IPC `session.start`
handler passes the flag through.

## Data flow (private session lifetime)

1. User types `/p fix my audio` → `onPrivateConversation` → `session.start`
   with `private: true`.
2. `SessionManager.start` → `PrivacyAwareRepo.createSession` registers the id and
   creates an in-memory meta. Nothing is written to SQLite.
3. Turns stream as normal; messages persist to the in-memory map. The renderer
   displays them from its own Zustand store (unchanged).
4. Reflection triggers fire but `ReflectionPipeline.run` returns
   `skipped: true, reason: 'private'` for the private id. `knowledge_append` /
   `bumpFactUse` no-op.
5. On close (e.g. starting another conversation), `dropPrivate` frees memory.
   Nothing remains on disk.

## Error handling

- **Crash mid-session:** because nothing is written to disk, a crash leaves no
  residue — the privacy guarantee holds even on unclean exit.
- **Memory growth:** private sessions retain messages in memory until
  `dropPrivate` or app exit. Expected to be small; no cap in v1.
- **Reflection race:** the gate lives at the top of `ReflectionPipeline.run`,
  the single chokepoint every trigger path funnels through, so there's no window
  where a private session's transcript gets reflected on.

## Testing

- `manual-prefix.test.ts` — `/p ` parsing (match, non-match, remainder, trailing
  space), symmetric to existing `/n ` cases.
- `CommandBar.test.tsx` — typing `/p ` fires `onPrivateConversation`; submitting
  `/p <text>` routes correctly; `/n ` behavior unchanged.
- New `privacy-aware-repo.test.ts` — private writes never hit the underlying
  `Repo` (assert with a spy/in-memory base), reads come from memory,
  `listSessions` excludes private, `isPrivate`/`dropPrivate` behave.
- Reflection gate — a `pipeline.test.ts` case: `run()` for a private session id
  returns `skipped: true, reason: 'private'` and never calls `runReflector`.
- `appendKnowledge` / `bumpFactUse` no-op for a private session id.

## Out of scope (v1)

- Keyboard shortcut for `/p` (the `/p ` prefix is enough to start).
- Any "private" badge or history affordance.
- Disabling `recall` / read-side memory (reads are intentionally allowed).
- Per-session memory caps for long-lived private sessions.
