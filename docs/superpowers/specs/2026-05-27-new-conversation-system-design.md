# New Conversation System

**Date:** 2026-05-27
**Status:** Approved — implementation planned in two phases (B first, D follows)

## Problem

Otto currently runs as a single, indefinitely-resumed SDK conversation. There is no way for the user — or the system — to draw a line and start fresh. This causes:

- Unrelated topics piling into one context window, hurting model focus and answer quality.
- Long-term memory/RAM bloat (see `project_ram_usage.md`: SDK-side conversation history is a primary compounder).
- No natural lifecycle event for cleanup, summarization, or knowledge-base capture.

We need a system that supports both **manual** and **automatic** new-conversation triggers, scoped and shipped in two phases.

## Goals

- User can explicitly start a new conversation in one keystroke.
- Conversations automatically end after a configurable period of total inactivity, so resuming Otto after a long gap doesn't drag yesterday's context forward.
- Long-running observation/watch tools do **not** trigger a new conversation; agent activity counts as conversation activity.
- Behavior is configurable; users who want a single forever-conversation can disable the automatic path.
- The architecture leaves a clean seam for phase 2 (topic-shift detection) without rework.

## Non-Goals (v1)

- Topic-shift detection (phase 2 — sketched at the bottom of this spec).
- Multi-conversation tabs / parallel conversations.
- Cross-conversation summarization or auto-handoff of context.
- Mid-conversation context compaction or truncation.

## Architecture

A single new main-process module — `ConversationPolicy` — decides, for each incoming user input, whether to **resume** the current SDK session or **start a fresh** one. It sits between the input handler and `SessionManager.start()`.

```
user input ──► InputHandler ──► ConversationPolicy.decide(input)
                                       │
                                       ├─ resume:  SessionManager.start({ resume: currentId })
                                       └─ fresh:   SessionManager.start({})   // no resume
```

`SessionManager`, `Repo`, and `SdkClient` are unchanged. We are adding policy, not rewiring plumbing — the existing `start({ resume? })` signature already supports both modes.

### State held by `ConversationPolicy`

- `lastActivityAt: number` — epoch ms, updated on **any** user input OR assistant stream event.
- `currentSessionId: string | null` — the session id to resume (mirrors `SessionManager.activeSessionId`).

State is in-memory only. On app restart, the policy starts fresh (no resume across restarts is fine — restarts are themselves a natural break).

### Settings

Stored alongside existing app settings:

| Key                                | Type    | Default | Notes                                   |
| ---------------------------------- | ------- | ------- | --------------------------------------- |
| `newConversation.idleTimeoutMinutes` | number  | `60`    | `0` disables idle-based new conversations |
| `newConversation.manualPrefix`     | string  | `"/n "` | Configurable; must end in a space       |

Exposed in the Settings window under a new "Conversations" section.

## Triggers (v1)

### Manual

Two surfaces, both routed through `ConversationPolicy.requestNew()`:

1. **In-input prefix.** When the input buffer **starts** with the configured prefix (default `/n `), the prefix is stripped and a new conversation is started. Two sub-behaviors:
   - `"/n "` alone (then user presses Enter or just hits space): start a new conversation, input becomes empty.
   - `"/n do the thing"`: start a new conversation AND submit "do the thing" as its first message in one action.
   - The prefix is **only** recognized at the start of the buffer; `"please /n now"` is literal text.
2. **Button + hotkey.**
   - A "+" / "New conversation" affordance in the chat header.
   - A global shortcut while Otto's main window is focused — proposed: `Cmd/Ctrl+Shift+N`. (Exact binding to be confirmed during implementation; must not conflict with existing shortcuts.)

### Idle timeout

On every:
- user input submission, AND
- assistant stream event (`text-delta`, `tool-call-start`, `tool-call-result`, `message-end`, `session-id`)

…`lastActivityAt` is set to `Date.now()`.

When the user submits a new message, `ConversationPolicy.decide()` runs **before** `SessionManager.start()`:

```
if idleTimeoutMinutes > 0
   AND now - lastActivityAt > idleTimeoutMinutes * 60_000:
   → start fresh (resume = undefined)
else:
   → resume current session
```

Because assistant events count as activity, a long-running watch tool (e.g., a 90-minute screen observer) keeps the conversation alive — exactly the desired behavior.

## UI

When a fresh conversation starts (manual or idle), the chat view inserts a subtle divider:

```
─── New conversation · 2:14 PM ───
```

This gives the user an unambiguous visual signal that context was cleared. No modal, no confirmation — the action is cheap and reversible (the previous conversation is still in history; we're just not resuming it).

## Testing

- **Unit:** `ConversationPolicy.decide()` is table-driven over combinations of:
  - idle elapsed (under threshold, over threshold, threshold disabled)
  - manual request flag (set, unset)
  - current session id (present, null)
- **Unit:** input prefix parser recognizes `/n ` only at start of buffer, strips it correctly, and forwards remaining text (including empty string) to the submit pipeline.
- **Unit:** activity tracker advances on each of the listed stream event types.
- **Integration:** `SessionManager.start()` is called with `resume: undefined` when policy decides fresh; with `resume: <id>` otherwise.
- **Manual smoke:** simulate a long-running watch tool emitting tool-call-result events past the idle threshold and confirm the conversation is NOT rolled over on the next user input.

## Phase 2 — Topic-Shift Detection (D) — Out of Scope for v1

Not built in v1. Sketched here so the v1 architecture leaves room for it. A separate brainstorm → spec → plan cycle will refine this before implementation.

**Trigger gate:** only evaluate when (a) idle elapsed ≥ 5 minutes but < `idleTimeoutMinutes`, AND (b) user submits a new input. Mid-flow continuations are never evaluated, eliminating most false positives.

**Signal:** cosine similarity between the embedding of the new prompt and a rolling embedding of the last N turns of the current conversation. Reuse existing `@xenova/transformers` + `src/main/embeddings/`.

**UX — suggest, do not switch.** If similarity falls below a calibrated threshold, surface a non-blocking chip above the input: `Start new conversation? · Yes / Keep going`. **Never auto-switch silently.** The cost of a wrong suggestion is one ignored chip; the cost of a wrong auto-switch is unrecoverable context loss.

**Optional escalation:** if the embedding signal is ambiguous (near-threshold), an LLM judge could be invoked. Defer this decision to the phase 2 spec.

**Integration point:** the chip-surfacing logic plugs into `ConversationPolicy` as an additional decision path; the same `requestNew()` entrypoint handles confirmation.

## File-level Impact (Estimated)

- **New:** `src/main/agent/conversation-policy.ts` (+ test)
- **New:** `src/main/agent/input-prefix-parser.ts` (+ test) — small, isolated parser for the `/n ` prefix
- **Edit:** input handler in `src/main/input/` to call `ConversationPolicy.decide()` before delegating to `SessionManager`
- **Edit:** `SessionManager` (`src/main/agent/session.ts`) — emit a hook for assistant activity so `ConversationPolicy` can subscribe (or have the policy listen to the existing event stream)
- **Edit:** settings schema + settings window for the two new keys
- **Edit:** renderer chat view to render the "New conversation" divider; renderer keyboard handler for the global shortcut
- **Edit:** any place that currently assumes a single forever-session in tests

## Open Questions

- Exact key binding for the manual shortcut — confirm during implementation that `Cmd/Ctrl+Shift+N` is free.
- Should the divider include the *reason* (`"New conversation (idle 1h 12m)"`) or stay minimal? Lean minimal for v1; can add later if useful.
