# Topic-Shift Detection (Phase 2)

**Date:** 2026-05-27
**Status:** Approved — implementation pending
**Builds on:** `2026-05-27-new-conversation-system-design.md` (Phase 1)

## Problem

Phase 1 shipped manual (`/n␣`, hotkey) and idle-timeout-based new conversations. The remaining gap from that spec: when a user comes back after a short gap and asks something **unrelated** to what they were just discussing, Otto should notice and suggest a fresh conversation — instead of dragging the prior context into a different topic.

We resolve this by computing an embedding-based similarity between the new prompt and the rolling recent context. When the user has been idle for at least 5 minutes AND the new prompt looks unrelated, surface a non-blocking chip suggesting a new conversation. Never auto-switch.

## Goals

- Catch obvious topic shifts after a short idle gap (lunch, meeting, etc.) and offer a clean break.
- Surface the suggestion as a low-friction chip; the user is always in control.
- Never lose the staged user message — both branches of the chip send it to *some* session.
- Zero impact on submits inside the idle window (no embedding cost, no latency).
- Fail open: any error in the detector falls back to "no suggestion" — the submit always proceeds.

## Non-Goals (v1)

- LLM-judge fallback for ambiguous similarity scores.
- User-configurable threshold or sensitivity slider.
- Auto-switch without user confirmation.
- Cross-conversation context transfer ("move that message to a new conversation").
- Pre-emptive embedding/caching during idle.

## Architecture

A new main-process module `TopicShiftDetector` answers one question: *"Given a new user prompt in a given session, should we suggest a new conversation?"* It composes:

- The existing `Embedder` (`src/main/embeddings/embedder.ts`, `@xenova/transformers`).
- A small policy: idle gate + similarity threshold.

A new IPC channel `topicShift.evaluate({ sessionId, newPrompt })` returns `{ suggest: boolean, similarity: number }`. The renderer calls this inside `App.tsx.handleSubmit` **only** when the idle gate has elapsed; otherwise it skips evaluation entirely.

`ConversationPolicy` is unchanged. The "Start new conversation" branch of the chip invokes the existing phase-1 `handleNewConversation({ text, attachments })`, which already abandons the prior session, starts a fresh one, and sends the staged message into it.

```
user hits Enter
   │
   ▼
CommandBar.handleSubmit (renderer)
   │
   ├─ /n prefix?  ──► existing phase-1 path (unchanged)
   │
   ▼
App.tsx.handleSubmit
   │
   ├─ idle ≥ 5 min since last user msg? ──no──► normal submit (unchanged)
   │  yes
   ▼
ipc.invoke('topicShift.evaluate', { sessionId, newPrompt })
   │
   ▼
Main: TopicShiftDetector
   ├─ buildContextWindow(sessionId) → string  (≤ ~2000 chars, ends on a message boundary)
   ├─ embedder.embedBatch([context, newPrompt]) → [v1, v2]
   ├─ cosineSimilarity(v1, v2)
   └─ return { suggest: sim < 0.35, similarity: sim }
   │
   ▼
Renderer:
   suggest === false  → proceed with normal submit
   suggest === true   → show chip; stage { text, attachments }
                        ├─ "Start new"  → handleNewConversation({ text, attachments })
                        └─ "Keep going" → onSubmit({ text, attachments })
```

## Components

### `TopicShiftDetector` (main)

`src/main/agent/topic-shift-detector.ts`

```ts
export interface TopicShiftDetectorDeps {
  repo: Pick<Repo, 'loadMessages'>;
  embedder: Pick<Embedder, 'embedBatch' | 'isAvailable'>;
}

export interface EvaluateResult {
  suggest: boolean;
  similarity: number; // NaN when detector is unavailable or fails
}

export class TopicShiftDetector {
  constructor(deps: TopicShiftDetectorDeps);
  evaluate(sessionId: string, newPrompt: string): Promise<EvaluateResult>;
  buildContextWindow(sessionId: string): string; // exposed for unit testing
}
```

- `evaluate` short-circuits to `{ suggest: false, similarity: NaN }` if:
  - `embedder.isAvailable` is false
  - the context window is empty (fresh session)
  - any exception is thrown during embedding or similarity computation
- All early returns are logged at info/warn level.

### Idle-gate check (renderer)

The renderer is authoritative about when to call `evaluate`. The `ConversationPolicy` work in phase 1 already tracks `lastActivityAt` for the *full* idle-timeout system, but topic-shift needs **last user-message time only** (per the design decision — `c`). The renderer holds this state itself, since it's purely a UX gate.

Add to `App.tsx`:

```ts
const lastUserSubmitAt = useRef<number>(0);
```

- Update on every successful submit (including chip's "Keep going" and "Start new" branches).
- On submit, compute `idleMs = Date.now() - lastUserSubmitAt.current`. If `idleMs >= 5 * 60 * 1000`, call `topicShift.evaluate`. Otherwise proceed normally.
- A fresh `App.tsx` mount initializes `lastUserSubmitAt.current = Date.now()` so the very first submit of a session doesn't trigger evaluation.

### Chip component

`src/renderer/components/TopicShiftChip.tsx`

Props: `{ onStartNew(): void; onKeepGoing(): void }`. Stateless presentational. Renders an inline pill above the `CommandBar`, styled with existing token classes (`bg-surface`, `border-border`, `text-muted-foreground`, accent border on the primary button). Escape key while visible → calls `onKeepGoing`.

```tsx
<div role="alertdialog" className="otto-topic-shift-chip ...">
  <div className="text-sm">This looks like a new topic.</div>
  <div className="flex gap-2 mt-1.5">
    <button onClick={onStartNew} className="px-2 py-1 rounded bg-accent text-white text-xs">Start new conversation</button>
    <button onClick={onKeepGoing} className="px-2 py-1 rounded text-muted-foreground text-xs hover:text-text">Keep going</button>
  </div>
</div>
```

### Wiring in `App.tsx`

Add a state slot for the staged payload:

```ts
const [pendingTopicShift, setPendingTopicShift] = useState<
  { text: string; attachments: ImageRef[] } | null
>(null);
```

Modify `handleSubmit`:

1. If `lastUserSubmitAt` is < 5 min ago, run the existing submit flow unchanged.
2. Otherwise, `await ipc.invoke('topicShift.evaluate', { sessionId, newPrompt: text })`. (Wrap in `try/catch` so any error falls through to the normal submit path.)
3. If `suggest === false` → existing submit flow.
4. If `suggest === true` → `setPendingTopicShift({ text, attachments })`. Render the chip; the actual submit waits for the user's chip choice.

Render the chip conditionally above the `CommandBar` when `pendingTopicShift !== null`. The chip's callbacks:

```ts
onStartNew: () => {
  const p = pendingTopicShift;
  setPendingTopicShift(null);
  if (p) void handleNewConversation(p);
}
onKeepGoing: () => {
  const p = pendingTopicShift;
  setPendingTopicShift(null);
  if (p) void handleSubmitInternal(p); // bypasses the idle check to avoid re-evaluating
}
```

`handleSubmitInternal` is a small refactor: split `handleSubmit` into a wrapper (does the idle check) and an inner function (does the actual submit). The wrapper is called from `CommandBar.onSubmit`; the inner function is called from the chip's "Keep going" path.

## Constants

`src/main/agent/topic-shift-detector.ts`:

```ts
const SIMILARITY_THRESHOLD = 0.35;       // below = suggest new conversation
const CONTEXT_WINDOW_CHARS = 2000;
const IDLE_GATE_MS = 5 * 60 * 1000;      // 5 minutes — also referenced in App.tsx
```

`IDLE_GATE_MS` is duplicated in `App.tsx` (since the gate is enforced renderer-side). Both reference the same shared constant exported from `src/shared/topic-shift-constants.ts` to avoid drift.

## Context window assembly

`TopicShiftDetector.buildContextWindow(sessionId)`:

1. Load messages newest-first via `repo.loadMessages(sessionId)` (already exists).
2. For each message, extract plain-text content only:
   - User messages: concatenate all `{ type: 'text' }` blocks in `content`.
   - Assistant messages: concatenate all `{ type: 'text' }` blocks; skip `tool_use`, `tool_result`, `image-ref`, etc.
   - System messages: skip entirely.
3. Prefix each extracted text with the role: `"user: "` or `"assistant: "`.
4. Accumulate newest-first, joining with `\n`, until total length crosses `CONTEXT_WINDOW_CHARS`. Stop at the next message boundary — never slice mid-message.
5. **Reverse** the accumulated list so the final string is chronological (oldest-of-window first, newest last). Embedding is order-sensitive, and chronological order matches what the embedder saw during training.
6. If the conversation has no extractable text (e.g., only tool calls / system messages), return `''`.

## Error handling

| Failure | Behavior |
| --- | --- |
| Embedder unavailable (`isAvailable === false`) | `evaluate` returns `{ suggest: false, similarity: NaN }`. Logged once per process at startup. |
| Embedding inference throws | Caught in `evaluate`. Logged at warn. Returns `{ suggest: false, similarity: NaN }`. Submit proceeds. |
| Empty context window | `evaluate` returns `{ suggest: false, similarity: NaN }`. No log (expected for fresh sessions). |
| IPC timeout (renderer waits > 2 s for evaluate) | Renderer drops the evaluation result and proceeds with normal submit. Logged at warn. |
| Detector throws synchronously during construction | Catastrophic — let it propagate; main-process startup should fail loudly, not silently. |

**Invariant:** the user's submit always reaches *some* session. The detector cannot drop a message.

## Testing

### Unit

- **`buildContextWindow`** — table-driven over message shapes:
  - empty session → `''`
  - single short user message → `'user: hello'`
  - single message longer than 2000 chars → that one message (don't slice mid-message)
  - 10 short alternating user/assistant messages → all included, chronological order, role-prefixed
  - mix of text messages and tool-only messages → only text content makes it in
  - 100 small messages → window stops cleanly at the boundary that exceeds 2000 chars
- **`evaluate()`** — table-driven over (embedder availability, context-window content, similarity score from fake embedder):
  - embedder unavailable → `suggest: false, similarity: NaN`
  - empty context → `suggest: false, similarity: NaN`
  - similarity 0.50 → `suggest: false`
  - similarity 0.35 → `suggest: false` (strict less-than)
  - similarity 0.34 → `suggest: true`
  - embedder throws → `suggest: false, similarity: NaN`
- **Chip component** — renders given the two callbacks; both buttons fire the right one; Escape calls onKeepGoing.
- **App-level submit gate** (component test or behavior test) — first submit in app skips evaluate; submit 4 min after last user msg skips evaluate; submit 6 min after last user msg calls evaluate.

### Integration

- End-to-end through main IPC handler with a fake embedder: assert `topicShift.evaluate` returns the expected result given a fixed session in the repo.
- Component test for `App.tsx.handleSubmit`: with `pendingTopicShift` set, chip renders; "Start new" routes through `handleNewConversation`; "Keep going" routes through the inner submit path.

### Manual smoke

After implementation, verify:

1. Hold a coding conversation; reply within a minute → no chip.
2. Wait 6 minutes; ask about the same code → no chip.
3. Wait 6 minutes; ask "what's the weather like?" → chip appears. Click "Start new" → fresh session, the weather question lands as the first message.
4. Repeat step 3 but click "Keep going" → message lands in the existing coding conversation; no new session.
5. Idle 6 minutes with embedder disabled (force-set `isAvailable=false`) → no chip; submit proceeds normally.

## File-Level Impact (Estimated)

- **New:** `src/main/agent/topic-shift-detector.ts` (+ test)
- **New:** `src/shared/topic-shift-constants.ts` (shared `IDLE_GATE_MS` etc.)
- **New:** `src/renderer/components/TopicShiftChip.tsx` (+ test)
- **Edit:** `src/shared/ipc-contract.ts` — add `topicShift.evaluate` channel and arg/result types
- **Edit:** `src/main/ipc/handlers.ts` — register the new handler; accept `TopicShiftDetector` in `deps`
- **Edit:** `src/main/index.ts` — instantiate `TopicShiftDetector` with the existing `embedder` and `repo`, pass to `registerIpcHandlers`
- **Edit:** `src/renderer/App.tsx` — idle-gate check, evaluate call, `pendingTopicShift` state, chip rendering, refactor `handleSubmit` into outer/inner pair

## Open Questions

None blocking. Possible future iterations after we have real usage data:
- Tune `SIMILARITY_THRESHOLD` based on false-positive/false-negative reports.
- Expose threshold as hidden setting if power users want to tune.
- Consider LLM-judge escalation for similarities in a gray zone (0.30–0.40) if the embedding alone proves too noisy.
- Pre-embed rolling context during idle to eliminate even the sub-100ms latency.
