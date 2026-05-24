# Inline Memory-Update Note — Design

**Date:** 2026-05-23
**Status:** Draft for implementation

## Goal

Replace the OS-level "Otto learned N new things" notification with a subtle, dense, in-conversation system note like `2 playbooks, 1 fact created/updated`. Note is persisted in the session's message log so it survives reload.

## Non-goals

- No notification preferences for the inline note (it's always on; deliberately quiet).
- No click target / link to Memory in v1 (text-only).
- No retroactive backfill of historical reflections.
- No dismiss / collapse UI.

## Section 1 — Message shape & rendering

### New message role: `system`

`Message` union (`src/shared/messages.ts`) gains a fourth variant:

```ts
export interface SystemMessage extends BaseMessage {
  role: 'system';
}

export type Message = UserMessage | AssistantMessage | ToolMessage | SystemMessage;
```

`isSystemMessage` type guard added next to the existing role guards.

### New content block

`ContentBlock` union gains:

```ts
| {
    type: 'memory-update';
    facts: number;
    playbooks: number;
    antiPatterns: number;
    heuristics: number;
  }
```

A `SystemMessage`'s `content` array holds exactly one `memory-update` block in this iteration (room for future system-note types).

### Factory

```ts
export function newSystemMessage(content: ContentBlock[]): SystemMessage {
  return {
    id: newId('msg'),
    sessionId: null,
    seq: 0,
    createdAt: Date.now(),
    role: 'system',
    content,
  };
}
```

### Persistence

Existing `Repo.appendMessage` accepts any role string and stores `content` as JSON — no migration needed. `messageBody`/`rowToMessage` in `src/main/db/repo.ts` get a `'system'` branch that mirrors the `'tool'` branch (no extra fields, just `content`).

### Renderer

`MessageList` gets a new branch: when `message.role === 'system'` and `content[0].type === 'memory-update'`, render a single muted line. Format:

- Build parts from non-zero counts: `'1 fact'`, `'2 playbooks'`, `'3 anti-patterns'`, `'1 heuristic'`. Plural where count ≠ 1.
- Join with `', '` (no Oxford comma — list is at most 4 items, comma-style stays cleaner).
- Suffix with ` created/updated`.

Examples:
- `1 fact created/updated`
- `2 playbooks, 1 anti-pattern created/updated`
- `2 playbooks, 1 fact, 1 heuristic created/updated`

If the block somehow has all-zero counts (shouldn't happen — pipeline gates on non-empty), render nothing.

Style: `text-[11px] text-muted italic py-1 px-3`. No avatar, no card border, no role label. Sits in normal message order in the list.

## Section 2 — Pipeline wiring

### `PipelineResult` adds per-kind counts

In `src/main/reflection/pipeline.ts`:

```ts
export interface PipelineResult {
  savedFacts: number;
  savedArtifacts: number;
  savedByKind: { fact: number; playbook: number; anti_pattern: number; heuristic: number };
  capReached: ArtifactKind[];
  skipped: boolean;
  reason?: string;
}
```

The pipeline already increments per-kind counters inside its loop; the change is purely surfacing them on the result.

### `PipelineDeps` replaces `notifyLearned`

```ts
export interface PipelineDeps {
  repo: Repo;
  artifactRepo: ArtifactRepo;
  configDir: string;
  runReflector: (prompt: string) => Promise<ReflectOutcome>;
  appendSystemNote: (sessionId: string, content: ContentBlock) => void;
}
```

(Renamed from `notifyLearned`; arity and shape change.) The pipeline calls it once per non-empty reflection:

```ts
if (total > 0) {
  appendSystemNote(args.sessionId, {
    type: 'memory-update',
    facts: novelFacts.length,
    playbooks: kindCounts.playbook,
    antiPatterns: kindCounts.anti_pattern,
    heuristics: kindCounts.heuristic,
  });
}
```

### Bootstrap in `src/main/index.ts`

- Drop the `notifyLearned: (n) => tray.notifyLearned(n)` wire-up.
- Wire `appendSystemNote` to a closure that builds a `SystemMessage`, persists it via `repo.appendMessage`, and emits a new `system-message` event:

```ts
appendSystemNote: (sessionId, block) => {
  const msg = repo.appendMessage({
    ...newSystemMessage([block]),
    sessionId,
  });
  emitWithNotify({ type: 'system-message', sessionId, message: msg });
}
```

`emitWithNotify` already exists and pipes through the renderer; the `Notifier` (which it also invokes) ignores message types it doesn't recognize, so no behavior change there.

### New `SessionEvent`

In `src/shared/ipc-contract.ts`, extend the `SessionEvent` union with:

```ts
| { type: 'system-message'; sessionId: string; message: Message }
```

Renderer's session-event handler (in `src/renderer/state/store.ts` or wherever messages get appended) handles `'system-message'` by appending the message to the relevant session's list — same path used when loading historical messages.

### `TrayManager.notifyLearned` removal

Delete the `notifyLearned` method on `TrayManager` (in `src/main/tray.ts`) entirely — it's no longer called. The badge logic and other tray functions are untouched.

## Section 3 — Testing

- **`src/shared/messages.test.ts`** — add a test that round-trips a `SystemMessage` containing a `memory-update` block through a synthetic `messageBody`/`rowToMessage` cycle (or, more simply, asserts `newSystemMessage([{ type: 'memory-update', facts: 1, playbooks: 2, antiPatterns: 0, heuristics: 0 }])` produces the expected shape).
- **`src/main/db/repo.test.ts`** — add a test that `appendMessage` + `loadMessages` round-trips a system message with a `memory-update` content block.
- **`src/main/reflection/pipeline.test.ts`** — update the two existing assertions that referenced `notify`:
  - "appends facts and inserts new artifacts" — replace with `expect(appendSystemNote).toHaveBeenCalledWith('s1', { type: 'memory-update', facts: 1, playbooks: 1, antiPatterns: 0, heuristics: 0 })`.
  - "does not notify when reflector returns nothing" — replace with `expect(appendSystemNote).not.toHaveBeenCalled()`.
  - 500-cap and dedup tests don't reference notify and pass through unchanged.
- **`src/renderer/components/MessageList`** (or wherever messages render) — add a test: given a session with one `system` message holding `{ facts: 1, playbooks: 2, antiPatterns: 0, heuristics: 0 }`, the rendered DOM contains the text `2 playbooks, 1 fact created/updated`.
- **`src/main/tray.test.ts`** if it exists with a `notifyLearned` test — remove that test. If no such test exists, nothing to do.

## Files added / changed

**New:** none (the change is shape + wiring, no new modules).

**Modified:**
- `src/shared/messages.ts` — `SystemMessage`, `memory-update` content block, `newSystemMessage` factory, `isSystemMessage` guard.
- `src/shared/messages.test.ts` — round-trip test for the new shape.
- `src/main/db/repo.ts` — `'system'` branch in `messageBody` + `rowToMessage`.
- `src/main/db/repo.test.ts` — round-trip test.
- `src/main/reflection/pipeline.ts` — `PipelineDeps.appendSystemNote`, `PipelineResult.savedByKind`, switch from `notifyLearned` call to `appendSystemNote`.
- `src/main/reflection/pipeline.test.ts` — update notify→appendSystemNote assertions.
- `src/shared/ipc-contract.ts` — new `system-message` SessionEvent variant.
- `src/main/index.ts` — drop `notifyLearned`/`tray.notifyLearned`, add the `appendSystemNote` closure that persists + emits.
- `src/main/tray.ts` — delete `notifyLearned` method.
- `src/renderer/components/MessageList.tsx` (or its current location) — render branch for `system` + `memory-update`.
- Renderer session-event handler — append on `'system-message'`.

## Open questions deferred to implementation

- Exact location of the renderer's `MessageList` (the renderer was reshuffled during recent refactors). Implementation task should grep for `MessageList` and the session-event handler before editing.
- Whether to keep `TrayManager.notifyLearned` deletion in the same commit as the rest, or split. Recommend same commit since the only caller goes away in the same change.
