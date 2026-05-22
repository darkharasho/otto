# Otto Autonomy / Permission System — Design

**Date:** 2026-05-22
**Sub-project:** 2 of 6 (Autonomy)
**Status:** Spec, awaiting user review

## Context

Sub-project 1 (Skeleton) is live: Electron + global hotkey + Agent SDK + SQLite + stub `echo` tool. Otto can talk to Claude and exercise the tool-call pipeline end-to-end. Before adding real tools (shell, computer-use, web, observers), we need the permission/autonomy framework so every real tool plugs into a known-good gate.

The full vision (from `README.md` / `CLAUDE.md`):

> Autonomy is configurable across three modes (strict / balanced / full allow) with every tool tagged by action class (read/reversible/destructive/irreversible), plan-step confirmations, a hard denylist for catastrophic commands…

This spec covers the **framework** — modes, action-class tagging, the matrix that gates tool calls, the inline approval UI, and the per-tool denylist hook. No real tools are added; one new stub (`fake-mutate`, `destructive`) and another (`fake-wipe`, `irreversible`) exercise the framework.

## Goals

- Every `OttoTool` declares an `actionClass`: `read | reversible | destructive | irreversible`.
- Three modes (`strict | balanced | full-allow`) gate tool calls according to a fixed matrix.
- Inline approval cards appear in the chat panel when a call needs confirmation. Approve / Approve-for-session / Deny.
- Mode badge in the status footer; one-click change without restart. Persists in a settings JSON file.
- Per-tool **denylist hook**: each tool can declare `denyPatterns(input) → string | null` returning a deny reason or null. Denylist always wins; not bypassable from the UI.
- One new stub tool per non-`read` action class (`fake-mutate`, `fake-wipe`) so the framework can be smoke-tested without real consequences.
- Settings persisted at `~/.config/otto/settings.json` (XDG_CONFIG_HOME aware), versioned.

### Mode × Action-Class Matrix

|              | read   | reversible | destructive | irreversible |
|--------------|--------|------------|-------------|--------------|
| **strict**   | allow  | confirm    | confirm     | deny         |
| **balanced** | allow  | allow      | confirm     | deny         |
| **full-allow** | allow | allow     | allow       | confirm      |

- **allow**: tool runs immediately.
- **confirm**: agent's stream pauses, approval card renders inline; user clicks Approve / Approve-for-session / Deny.
- **deny**: tool refused before reaching execution; model sees `{ isError: true, content: 'Denied: <reason>' }`.

The denylist hook short-circuits the matrix: if `denyPatterns(input)` returns a non-null reason, the call is always denied.

## Non-Goals

- **Plan-level confirmations** (only per-tool-call confirmations in this sub-project).
- Real tools (shell, computer-use, web, observers — sub-projects 3–6).
- **Persistent permission grants across sessions.** "Approve for session" is in-memory only; restart clears it.
- A full settings page. The only setting today is the mode badge.
- Per-session mode (mode is global).
- Per-machine knowledge file (sub-project 6).
- A "bypass denylist" UI affordance. The denylist is intentionally hard.
- Env-var overrides for the mode. JSON file is the single source of truth.

## Architecture

A single new module — `src/main/autonomy/` — owns policy, decisions, and settings. Tools integrate by declaring their `actionClass` and (optionally) `denyPatterns`. The MCP tool handlers in `sdk-client.ts` become the enforcement choke point; `SessionManager` itself stays largely unchanged.

- **`autonomy/policy.ts`** — pure matrix. Function `evaluate(mode, actionClass, denyResult) → 'allow' | 'confirm' | 'deny'`. No state, no I/O.
- **`autonomy/decision-broker.ts`** — session-scoped, stateful. Owns:
  - The current mode (subscribes to `settings.onChange`).
  - The per-session "approve for session" cache (in-memory, keyed by `(sessionId, toolName)`).
  - The map of `decisionId → resolver` for pending approval round-trips.
  - The IPC `emit` callback for events to the renderer.
  - Public surface:
    - `decide(args: { sessionId, callId, toolName, actionClass, input, denyPatternsFn })`: returns `Promise<'allow' | 'deny'>` (after potentially awaiting a user decision). Emits the appropriate IPC events as a side effect.
    - `resolve(decisionId, decision)`: called from the IPC handler when the renderer reports a user choice.
- **`autonomy/settings.ts`** — JSON persistence + change emitter. Public surface: `load()`, `getMode()`, `setMode(mode)`, `onChange(cb) → unsubscribe`. Atomic write (`.tmp` → `rename`).

**Tool integration.** In `sdk-client.ts`, every wrapped tool handler now:

1. Calls `broker.decide(...)`.
2. On `'allow'` → executes the tool body, returns the SDK content envelope.
3. On `'deny'` → returns `{ isError: true, content: [{ type: 'text', text: 'Denied: <reason>' }] }` without executing.

This pushes the enforcement edge into the tool handler so SessionManager just forwards new IPC events — no policy logic in the session loop itself.

**Mode state propagation.** `settings.setMode` writes the JSON, updates the broker's `currentMode`, and main emits `autonomy.modeChanged`. The renderer's store updates the badge label.

### Directory Layout

```
src/main/autonomy/
  policy.ts            # pure matrix
  policy.test.ts
  decision-broker.ts   # state + IPC
  decision-broker.test.ts
  settings.ts          # JSON persistence
  settings.test.ts
src/renderer/components/
  ApprovalCard.tsx
  ApprovalCard.test.tsx
  ModeBadge.tsx
  ModeBadge.test.tsx
```

Existing files modified:
- `src/main/agent/tools.ts` — `OttoTool` gains `actionClass` and optional `denyPatterns`; add `fake-mutate` (destructive) and `fake-wipe` (irreversible) stubs.
- `src/main/agent/sdk-client.ts` — tool handlers consult `broker.decide`.
- `src/main/agent/session.ts` — forward new IPC events. No policy logic.
- `src/main/index.ts` — construct `Settings` + `DecisionBroker`, wire into deps.
- `src/main/ipc/handlers.ts` — `autonomy.decide`, `autonomy.getMode`, `autonomy.setMode`, `autonomy.modeChanged` event.
- `src/shared/ipc-contract.ts` — new `SessionEvent` variants (`tool-call-pending`, `tool-call-denied`, `tool-call-decided`); new IPC channels.
- `src/shared/messages.ts` — `pending_tool_use` and `tool_denied` content block kinds.
- `src/renderer/state/store.ts` — reducer for the new events.
- `src/renderer/components/StatusFooter.tsx` — mount `ModeBadge`.
- `src/renderer/components/Message.tsx` — render `pending_tool_use` (→ `ApprovalCard`) and `tool_denied` blocks.

## Components

### Main process

- **`Settings`** (`autonomy/settings.ts`):
  - `~/.config/otto/settings.json`, XDG_CONFIG_HOME aware.
  - Shape (`v1`):
    ```json
    { "version": 1, "autonomy": { "mode": "balanced" } }
    ```
  - `load()` reads; on missing or malformed, writes defaults and logs a warning.
  - `setMode(mode)`: atomic write (`.tmp` then `rename`), then fires listeners.
  - On unknown `version` → log a warning, fall back to defaults for unknown keys. Don't refuse to start.
  - Default: `balanced`.

- **`DecisionBroker`** (`autonomy/decision-broker.ts`):
  - In-memory state: current mode (initialized from `Settings`, updated via `settings.onChange`); pending decisions map; session approval cache.
  - `decide(...)` algorithm:
    1. Compute deny via `denyPatternsFn?.(input)`. If non-null reason: emit `tool-call-denied`, return `'deny'`.
    2. If session cache contains `(sessionId, toolName)`: return `'allow'` (skip the matrix).
    3. Run `evaluate(currentMode, actionClass)`. If `'allow'`: return `'allow'`. If `'deny'`: emit `tool-call-denied`, return `'deny'`.
    4. If `'confirm'`: allocate `decisionId`, emit `tool-call-pending` with `{ callId, decisionId, name, input, actionClass, reason: 'mode=<mode>' }`, return a promise that resolves when `resolve(decisionId, choice)` is called or 5 minutes elapse.
    5. On resolve: if `'approve-session'`, add to cache and resolve `'allow'`. If `'approve'`, resolve `'allow'`. If `'deny'` or timeout, emit `tool-call-decided` with that choice and resolve `'deny'`.
  - Decision binding: the mode used in step 3 is captured at `decide()` call time. Switching mode while a decision is pending does **not** re-evaluate.
  - Timeout: 5 minutes. On timeout, emit `tool-call-decided` with `'deny'` and reason `'decision timed out'` so the SDK turn can complete.

- **`policy.ts`**: pure `evaluate(mode, actionClass) → 'allow' | 'confirm' | 'deny'`. Matrix-only; deny-pattern check is upstream in `DecisionBroker`.

### Renderer

- **`ApprovalCard.tsx`**: rendered inline in the message stream where the model attempted a tool call. Shows tool name, action class, one-line input summary, and three buttons (Approve, Approve for session, Deny). Submits via `autonomy.decide`. Cards remain visible after decision (frozen state) so scrollback shows the choice that was made.
- **`ModeBadge.tsx`**: small chip in `StatusFooter`. Shows current mode with a colored dot (strict=red, balanced=amber, full-allow=green). Click → popover with three options + brief one-liner each.
- **Store updates** (`renderer/state/store.ts`):
  - On `tool-call-pending`: push a `pending_tool_use` block onto the active assistant message.
  - On `tool-call-decided` with `'approve'` or `'approve-session'`: transform the matching block to `tool_use`. Subsequent `tool-call-start` / `tool-call-result` events continue to flow as usual.
  - On `tool-call-decided` with `'deny'` or `tool-call-denied`: transform the matching block to `tool_denied`.
- **New content blocks** (`shared/messages.ts`):
  - `{ type: 'pending_tool_use', callId, decisionId, name, input, actionClass, reason }`
  - `{ type: 'tool_denied', callId, name, input, reason }`
  - Persistence: pending blocks should not appear in DB rows (they're transient UI state). If the turn ends with a still-pending block, the broker will have timed it out by then and emitted `tool-call-decided` with `'deny'`, converting it to `tool_denied`. The renderer-side reducer collapses pending into denied or used before SessionManager finalizes the message.

## Data Flow

### Confirm Flow

1. Model issues a tool call inside the MCP handler in `sdk-client.ts`.
2. Handler calls `broker.decide(...)`.
3. Broker computes `'confirm'`, allocates `decisionId`, emits `tool-call-pending`, returns pending promise.
4. Renderer pushes a `pending_tool_use` block; `ApprovalCard` renders.
5. User clicks Approve (or Approve-for-session / Deny). Renderer invokes `autonomy.decide({ decisionId, decision })`.
6. Main: IPC handler calls `broker.resolve(decisionId, decision)`. Broker resolves promise; emits `tool-call-decided`.
7. MCP handler awaits resolution. On `'allow'`: runs the tool body, returns `{ content }`. On `'deny'`: returns `{ isError: true, content: 'Denied by user' }`.
8. Renderer transforms the pending block. Normal `tool-call-start` / `tool-call-result` events follow if approved.

### Deny Flow (Matrix or Denylist)

1. Model issues a tool call. MCP handler calls `broker.decide(...)`.
2. Broker computes `'deny'` (from deny pattern or matrix). Emits `tool-call-denied` with reason. Returns `'deny'`.
3. Handler returns `{ isError: true, content: 'Denied: <reason>' }`. Model sees the denial.
4. Renderer pushes a `tool_denied` content block.

### Mode Change

1. User picks `balanced` in `ModeBadge` popover. Renderer invokes `autonomy.setMode({ mode })`.
2. Main: `settings.setMode('balanced')` writes the JSON, fires listeners. Broker updates `currentMode`. Main emits `autonomy.modeChanged`.
3. Renderer store updates; badge re-renders. Future calls use the new mode.

### Approve-for-Session Cache

- Key: `(sessionId, toolName)`. Set on `'approve-session'`. In-memory only; lives on the `DecisionBroker` instance; cleared on process exit.
- Effect: `decide` returns `'allow'` immediately (after the deny-pattern check, before the matrix). Denylist still applies.

## Error Handling

| Case | Behavior |
|------|----------|
| Mode change mid-pending-decision | Decision uses the mode captured at `decide()` call. Mode change does not re-evaluate. |
| Main crash with pending decisions | MCP handler promise never resolves → SDK turn errors → SessionManager catches, emits `error`. Pending block remains in DB as part of the errored assistant message until the renderer reducer reconciles on next load. |
| Renderer crash with pending decision | Broker times out after 5 minutes, emits `tool-call-decided` with `'deny'`, SDK turn completes with a denied tool result. |
| Settings file read corrupt / missing | Use defaults, log warning, write fresh defaults file. |
| Settings file write failure | Log error; reject the mode change in-memory too. Re-emit `autonomy.modeChanged` with the previous mode so renderer doesn't show stale state. |
| Decision timeout (5 min) | Resolve as `'deny'` with reason `'decision timed out'`. Emit `tool-call-decided`. |
| Concurrent pending decisions | Each has its own `decisionId`; resolved independently. Multiple cards can be visible at once. |
| Denylist false-positive | No UI bypass. User edits the tool's `denyPatterns` source. |

**Logging:** broker decisions logged at `info` level (mode, tool, class, outcome). Denylist hits at `warn`. Settings load/write at `info` for writes, `warn` for errors.

## Testing

### Unit (Vitest)

- **`policy.test.ts`** — exhaustive: 12 cells (3 modes × 4 classes) + the explicit deny pass-through (when the broker's deny-pattern step short-circuits, policy isn't even called; that's a broker test).
- **`decision-broker.test.ts`**:
  - Allow flow: matrix returns `'allow'` → `decide` resolves synchronously.
  - Confirm flow: emits pending event, awaits `resolve(...)`, returns the right outcome for each of `approve` / `approve-session` / `deny`.
  - Session cache: second call to same tool in same session after `approve-session` returns `'allow'` without emitting a new pending event.
  - Session cache does NOT bypass denylist: tool denied by `denyPatterns(input)` stays denied even when in cache.
  - Deny pattern: returns `'deny'` synchronously, emits `tool-call-denied`.
  - Timeout: pending decision auto-denies after 5 min (use fake timers).
  - Mode-change isolation: decision started in `strict` stays `strict` even if mode flips to `full-allow` mid-await.
- **`settings.test.ts`**:
  - Loads defaults when file missing; writes a fresh defaults file as a side effect.
  - Round-trips a mode change (write → read).
  - Malformed JSON → defaults + warning, fresh file written.
  - Unknown future version → defaults for unknown keys + warning; doesn't throw.
  - `onChange` fires on `setMode`; unsubscribe stops further callbacks.

### Component (Vitest + RTL)

- **`ApprovalCard.test.tsx`**:
  - Renders tool name, action class, input summary.
  - Three buttons each call the right `autonomy.decide({ decision })`.
  - Post-decision: buttons disabled, decision badge visible (Approved / Denied), card stays in stream.
- **`ModeBadge.test.tsx`**:
  - Shows current mode with the right colored dot.
  - Popover lists the three options; clicking dispatches `autonomy.setMode`.
  - Disabled state while a setMode is in flight.

### Reducer

- Store handles `tool-call-pending` (push block), `tool-call-decided` (transform), `tool-call-denied` (push denied block).

### Integration (Playwright)

- Extend `tests/integration/smoke.spec.ts` with a confirm-flow scenario:
  - Before launching Electron, write `settings.json` (mode `balanced`) into the test's `XDG_CONFIG_HOME` temp dir. (No env-var override exists; settings file is the only configuration mechanism.)
  - Fake SDK emits a `fake-mutate` tool call.
  - Test asserts an `ApprovalCard` renders, clicks Approve, asserts the resulting `tool_use` + `tool_result` blocks render.

### Manual Verification Checklist

Run before declaring sub-project done:

- [ ] Mode badge shows current mode; clicking switches it without restart.
- [ ] In `balanced`, `fake-mutate` prompts; Approve runs it, Deny short-circuits with a denied card visible.
- [ ] Approve-for-session: second `fake-mutate` call same session runs without prompting; new session prompts again.
- [ ] In `strict`, `fake-wipe` (irreversible) is denied with reason `'mode=strict'`.
- [ ] In `full-allow`, `fake-wipe` (irreversible) prompts; Approve runs it.
- [ ] Settings JSON file persists across app restart (`mode: full-allow` survives quit-and-reopen).
- [ ] Malformed `settings.json` → app launches fine with defaults and a warning in `~/.config/otto/logs/main.log`.
- [ ] Denylist (when a tool defines one) always denies regardless of mode. (Not exercised by stubs; verify by temporarily adding a `denyPatterns` to `fake-mutate`.)

## Open Questions

None blocking. Future-deferred items (plan-level confirmations, cross-session permission persistence, settings UI beyond the badge) are tracked in Non-Goals and pick up in later sub-projects or polish passes.
