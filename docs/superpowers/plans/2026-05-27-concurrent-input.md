# Concurrent Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user submit additional messages while Otto is still responding, instead of locking the CommandBar until the current turn completes.

**Architecture:** The `@anthropic-ai/claude-agent-sdk` `query()` call already supports a streaming-input mode (`prompt: AsyncIterable<SDKUserMessage>`) and the returned `Query` exposes `interrupt()`. Today Otto opens one `query()` per turn, which forces the renderer to gate input on completion. We will move to **one long-lived `query()` per session**, fed by a per-session message queue. Each user submit pushes onto that queue; the CommandBar never disables. The Stop button maps to `Query.interrupt()`, and a new "Send & interrupt" affordance lets the user preempt the current turn.

**Tech Stack:** TypeScript, Electron, React, Zustand, `@anthropic-ai/claude-agent-sdk` 0.1.x (streaming-input mode), vitest.

**Key open unknown (Task 0 spike resolves this):** When a second `SDKUserMessage` is yielded into the query's prompt iterable *while the model is still generating*, does the Claude Code CLI buffer it until the current turn finishes, or does it inject it as a follow-up user-block into the active turn? The SDK docstring ("Used internally for multi-turn conversations") implies buffering. The spike verifies this; the rest of the plan assumes buffering and uses `interrupt()` for preempt semantics. If the spike disproves the assumption, revise Task 4 and Task 5 before continuing.

---

## File Structure

**New files:**
- `src/main/agent/session-stream.ts` — owns the long-lived `query()` invocation per session, the user-message queue, and the per-incoming-message context (messageId, MCP server). Replaces the per-turn closure in `sdk-client.ts`.
- `src/main/agent/session-stream.test.ts` — unit tests for the queue + interrupt logic against a fake `Query`.
- `scripts/spike-streaming-input.ts` — Task 0 spike script. Deleted after the spike, do not commit.

**Modified files:**
- `src/main/agent/session.ts` — `SessionManager.send` no longer creates a turn; it enqueues onto the session's `SessionStream`. New `SessionManager.ensureStream(sessionId)`.
- `src/main/agent/sdk-client.ts` — `SdkClient` gains `openStream(sessionId, resumeId)` returning a `SessionStream` handle; `sendTurn` is removed.
- `src/shared/ipc-contract.ts` — `SessionEvent` gains `queued-user-message` and `turn-boundary` variants; existing `done` event keeps its meaning (current turn finished) but is no longer terminal for the renderer's `streaming` flag.
- `src/renderer/state/store.ts` — `ActiveSessionState` gains `queueDepth: number` and `currentTurnActive: boolean`; `streaming` becomes derived (`currentTurnActive || queueDepth > 0`).
- `src/renderer/components/CommandBar.tsx` — drop the `busy`-gated `disabled` on input and submit. Add a small queue-depth chip when `queueDepth > 0`. Keep Stop button; add modifier (Shift+Enter on submit while busy → interrupt + send).
- `src/renderer/App.tsx` — pass the new fields to CommandBar, wire `onInterruptAndSend`.

---

## Task 0: Verify SDK streaming-input behavior (spike)

**Files:**
- Create: `scripts/spike-streaming-input.ts` (delete after spike — not committed)

This task answers: when the prompt async-iterable yields a second user message while the model is mid-generation, does the CLI consume it immediately or after the current turn's `result` message?

- [ ] **Step 1: Write the spike script**

```ts
// scripts/spike-streaming-input.ts
import { query } from '@anthropic-ai/claude-agent-sdk';

async function main() {
  let resolveSecond: () => void = () => {};
  const secondGate = new Promise<void>((r) => { resolveSecond = r; });

  async function* prompt() {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content: 'Count slowly from 1 to 20, one number per line, with a short pause feel between each.' },
      parent_tool_use_id: null,
      session_id: 'spike',
    };
    await secondGate;
    console.log('[spike] yielding second user message');
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content: 'STOP counting. Say the word PINEAPPLE and nothing else.' },
      parent_tool_use_id: null,
      session_id: 'spike',
    };
  }

  const q = query({
    prompt: prompt(),
    options: { model: 'claude-haiku-4-5-20251001', tools: [], systemPrompt: 'You are a counter.' },
  });

  // Release the second message ~600ms in, while the model is still streaming.
  setTimeout(() => resolveSecond(), 600);

  for await (const msg of q) {
    console.log('[spike]', new Date().toISOString(), JSON.stringify(msg).slice(0, 240));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the spike**

Run: `npx tsx scripts/spike-streaming-input.ts 2>&1 | tee /tmp/spike.log`
Expected: stream prints model output. Observe whether PINEAPPLE appears (a) interleaved with the count, (b) as a separate assistant turn after the count finishes, or (c) the count is truncated mid-stream when the second message arrives.

- [ ] **Step 3: Record findings in plan**

Append a 3-line "Spike Result" block below this task in the plan file: which of (a)/(b)/(c) occurred, and any error messages. **If (a) or (c)**, true mid-stream injection works and Task 5's interrupt-on-preempt logic becomes optional — flag this and continue. **If (b)** (most likely), proceed as planned.

- [ ] **Step 4: Delete the spike script**

```bash
rm scripts/spike-streaming-input.ts
```

No commit — this is research, not code.

**Spike Result (2026-05-27):** Behavior (b) — buffering. First turn ran to completion (full count + `result` message at t=1.4s), then a fresh turn started for the second message (PINEAPPLE + `result` at t=2.2s). Same `session_id` across both. Each user message produces its own `system/init` + `assistant` + `result` sequence. Plan proceeds as written; `Query.interrupt()` is required for preempt semantics in Task 5.

---

## Task 1: Define `SessionStream` interface and queue primitives

**Files:**
- Create: `src/main/agent/session-stream.ts`
- Create: `src/main/agent/session-stream.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/agent/session-stream.test.ts
import { describe, it, expect } from 'vitest';
import { createMessageQueue } from './session-stream';

describe('createMessageQueue', () => {
  it('yields pushed items in order across awaits', async () => {
    const q = createMessageQueue<number>();
    q.push(1);
    q.push(2);
    const iter = q.iterable[Symbol.asyncIterator]();
    expect((await iter.next()).value).toBe(1);
    expect((await iter.next()).value).toBe(2);
  });

  it('waits when empty and resolves when an item arrives', async () => {
    const q = createMessageQueue<number>();
    const iter = q.iterable[Symbol.asyncIterator]();
    const pending = iter.next();
    setTimeout(() => q.push(42), 10);
    expect((await pending).value).toBe(42);
  });

  it('close() ends the iteration', async () => {
    const q = createMessageQueue<number>();
    q.close();
    const iter = q.iterable[Symbol.asyncIterator]();
    expect((await iter.next()).done).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/agent/session-stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the queue**

```ts
// src/main/agent/session-stream.ts
export interface MessageQueue<T> {
  push(item: T): void;
  close(): void;
  readonly iterable: AsyncIterable<T>;
  readonly depth: () => number;
}

export function createMessageQueue<T>(): MessageQueue<T> {
  const buffer: T[] = [];
  const waiters: Array<(v: IteratorResult<T>) => void> = [];
  let closed = false;

  function push(item: T): void {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else buffer.push(item);
  }

  function close(): void {
    closed = true;
    while (waiters.length > 0) waiters.shift()!({ value: undefined as never, done: true });
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffer.length > 0) return Promise.resolve({ value: buffer.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  return { push, close, iterable, depth: () => buffer.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/agent/session-stream.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/session-stream.ts src/main/agent/session-stream.test.ts
git commit -m "feat(agent): add message queue primitive for concurrent input"
```

---

## Task 2: Implement `SessionStream` wrapping `query()`

**Files:**
- Modify: `src/main/agent/session-stream.ts`
- Modify: `src/main/agent/session-stream.test.ts`

`SessionStream` owns one long-lived `query()` for a session. It exposes:
- `enqueueUserMessage({ text, attachments, messageId })` — push onto the queue.
- `interrupt()` — call `Query.interrupt()` on the underlying SDK query.
- `events()` — async-iterable of `SdkStreamEvent` enriched with `messageId` (which user message a given event belongs to).
- `close()` — close the prompt iterable, which causes the SDK subprocess to exit.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/main/agent/session-stream.test.ts
import { createSessionStream, type QueryFactory } from './session-stream';

describe('createSessionStream', () => {
  it('forwards enqueued user messages to the query factory and tags events with messageId', async () => {
    const yielded: string[] = [];
    const factory: QueryFactory = ({ prompt }) => {
      return {
        async *[Symbol.asyncIterator]() {
          for await (const m of prompt) {
            yielded.push(m.message.content as string);
            yield { type: 'assistant', message: { content: [{ type: 'text', text: `echo:${m.message.content}` }] }, session_id: 's', uuid: 'u' };
          }
        },
        interrupt: async () => {},
      } as unknown as ReturnType<QueryFactory>;
    };

    const stream = createSessionStream({ sessionId: 's', queryFactory: factory });
    stream.enqueueUserMessage({ messageId: 'm1', text: 'hello', attachments: [] });
    stream.enqueueUserMessage({ messageId: 'm2', text: 'world', attachments: [] });

    const events: Array<{ messageId: string; type: string }> = [];
    const iter = stream.events()[Symbol.asyncIterator]();
    for (let i = 0; i < 2; i++) {
      const { value } = await iter.next();
      events.push({ messageId: value.messageId, type: value.type });
    }
    stream.close();
    expect(yielded).toEqual(['hello', 'world']);
    expect(events.map((e) => e.messageId)).toEqual(['m1', 'm2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/agent/session-stream.test.ts`
Expected: FAIL — `createSessionStream` not exported.

- [ ] **Step 3: Implement `createSessionStream`**

```ts
// add to src/main/agent/session-stream.ts
import type { SDKUserMessage, SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlock } from '@shared/messages';
import { promises as fsp } from 'node:fs';

export type EnqueuedMessage = {
  messageId: string;
  text: string;
  attachments: Array<Extract<ContentBlock, { type: 'image-ref' }>>;
};

export interface SessionStreamEvent {
  messageId: string;
  type: 'assistant-message' | 'result' | 'system' | 'partial';
  raw: SDKMessage;
}

export type QueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage> & { interrupt: () => Promise<void> };

export interface SessionStream {
  enqueueUserMessage(msg: EnqueuedMessage): void;
  interrupt(): Promise<void>;
  events(): AsyncIterable<SessionStreamEvent>;
  close(): void;
  queueDepth(): number;
}

export function createSessionStream(args: {
  sessionId: string;
  queryFactory: QueryFactory;
  options?: Partial<Options>;
}): SessionStream {
  const inbox = createMessageQueue<EnqueuedMessage>();
  let currentMessageId: string | null = null;

  async function* promptIterable(): AsyncIterable<SDKUserMessage> {
    for await (const m of inbox.iterable) {
      currentMessageId = m.messageId;
      const content: unknown[] = [];
      if (m.text.length > 0) content.push({ type: 'text', text: m.text });
      for (const a of m.attachments) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: a.mimeType, data: (await fsp.readFile(a.path)).toString('base64') },
        });
      }
      yield {
        type: 'user',
        message: { role: 'user', content: content as never },
        parent_tool_use_id: null,
        session_id: args.sessionId,
      } as SDKUserMessage;
    }
  }

  const q = args.queryFactory({
    prompt: promptIterable() as AsyncIterable<SDKUserMessage>,
    options: (args.options ?? {}) as Options,
  });

  async function* events(): AsyncIterable<SessionStreamEvent> {
    for await (const raw of q) {
      const type = mapType(raw);
      yield { messageId: currentMessageId ?? '', type, raw };
    }
  }

  return {
    enqueueUserMessage(msg) { inbox.push(msg); },
    interrupt: () => q.interrupt(),
    events,
    close() { inbox.close(); },
    queueDepth: () => inbox.depth(),
  };
}

function mapType(msg: SDKMessage): SessionStreamEvent['type'] {
  const t = (msg as { type?: string }).type;
  if (t === 'assistant') return 'assistant-message';
  if (t === 'result') return 'result';
  if (t === 'system') return 'system';
  return 'partial';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/agent/session-stream.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/session-stream.ts src/main/agent/session-stream.test.ts
git commit -m "feat(agent): SessionStream wraps long-lived query() with enqueue + interrupt"
```

---

## Task 3: Wire `SessionStream` into `SdkClient`

**Files:**
- Modify: `src/main/agent/sdk-client.ts` (replace `sendTurn` with `openStream`)
- Modify: `src/main/agent/session.ts` (callers)
- Modify: `src/main/agent/session.test.ts` (fake SdkClient)

The per-turn closure currently at sdk-client.ts:599-690 moves into a single `openStream(sessionId, resumeId)` call. The MCP server (line 614) is rebuilt **per enqueued message** by hooking it into `SessionStream`'s per-message context, so each user message still gets a fresh `{ sessionId, messageId, broker }` closure.

- [ ] **Step 1: Update `SdkClient` interface**

In `src/main/agent/session.ts:42-50`, replace `SdkTurn`/`sendTurn` with:

```ts
export interface SessionStreamHandle {
  enqueue(args: { messageId: string; text: string; attachments: Array<Extract<ContentBlock, { type: 'image-ref' }>> }): void;
  interrupt(): Promise<void>;
  events(): AsyncIterable<SdkStreamEvent & { messageId: string }>;
  close(): void;
  queueDepth(): number;
}

export interface SdkClient {
  startSession(args: { resume?: string; model: string }): Promise<{ id: string }>;
  openStream(sessionId: string, resumeId: string | undefined, hooks: {
    onPerMessageContext: (messageId: string) => void;
  }): SessionStreamHandle;
}
```

- [ ] **Step 2: Implement `openStream` in `sdk-client.ts`**

Replace the `sendTurn` implementation (lines 599-690) with `openStream` that constructs `createSessionStream` from session-stream.ts, passing `(prompt, options) => sdk.query({ prompt, options })` as the `queryFactory`. Hook `onPerMessageContext` so each new `messageId` rebuilds the MCP server before the next message is consumed (use the `parent_tool_use_id`/sequential consumption guarantee). Keep `mapSdkMessage` and reuse it inside the events transformer.

- [ ] **Step 3: Update `SessionManager` (`session.ts`)**

- Add `private readonly streams = new Map<string, SessionStreamHandle>();`
- New method `private ensureStream(sessionId, resumeId)`: returns existing handle or creates one and spawns an async consumer loop that maps `SessionStreamEvent` → `SessionEvent` (the switch currently at lines 126-178).
- `send()` no longer creates a controller or runs `for await`; it appends the user message to the repo, emits `user-message`, then calls `ensureStream(sid).enqueue({ messageId: assistant.id, text, attachments })`.
- Track per-message assistant rows in a `Map<messageId, AssistantMessage>` instead of a single local `assistant`.

- [ ] **Step 4: Update session.test.ts**

Replace any `sdk.sendTurn(...)` fake with `sdk.openStream(...)` returning an object that records enqueued messages and lets the test push synthetic SDK events.

- [ ] **Step 5: Run all main-process agent tests**

Run: `pnpm vitest run src/main/agent`
Expected: PASS. Fix any breakages before committing.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent/session.ts src/main/agent/sdk-client.ts src/main/agent/session.test.ts
git commit -m "feat(agent): replace per-turn sendTurn with long-lived openStream"
```

---

## Task 4: Renderer — drop disable, show queue depth

**Files:**
- Modify: `src/renderer/state/store.ts` (add `queueDepth`, `currentTurnActive`)
- Modify: `src/renderer/components/CommandBar.tsx` (remove `busy`-gated `disabled`)
- Modify: `src/renderer/App.tsx` (pass new props)
- Modify: `src/renderer/state/store.test.ts` (assert queueDepth lifecycle)

- [ ] **Step 1: Add new IPC event types**

In `src/shared/ipc-contract.ts`, add to the `SessionEvent` union:

```ts
| { type: 'user-message-queued'; sessionId: string; messageId: string; queueDepth: number }
| { type: 'user-message-consumed'; sessionId: string; messageId: string; queueDepth: number }
```

Emit these from `SessionManager.send` (queued) and from the consumer loop at the point a new `messageId` becomes current (consumed).

- [ ] **Step 2: Extend store state**

In `src/renderer/state/store.ts:7-12`, change `ActiveSessionState`:

```ts
export interface ActiveSessionState {
  id: string;
  messages: Message[];
  currentTurnActive: boolean;
  queueDepth: number;
  error: StructuredError | null;
}
```

Add a getter-style derived value where `streaming` was previously consumed:

```ts
export function isSessionBusy(s: ActiveSessionState | null): boolean {
  return !!s && (s.currentTurnActive || s.queueDepth > 0);
}
```

Update `applyEvent` to handle the two new events (increment/decrement `queueDepth`); flip `currentTurnActive` on `message-start` / `done` as before.

- [ ] **Step 3: Update tests**

Add to `src/renderer/state/store.test.ts`:

```ts
it('tracks queueDepth across queued and consumed events', () => {
  const s = useOttoStore.getState();
  s.beginSession('sess');
  s.applyEvent({ type: 'user-message-queued', sessionId: 'sess', messageId: 'm1', queueDepth: 1 });
  s.applyEvent({ type: 'user-message-queued', sessionId: 'sess', messageId: 'm2', queueDepth: 2 });
  expect(useOttoStore.getState().activeSession?.queueDepth).toBe(2);
  s.applyEvent({ type: 'user-message-consumed', sessionId: 'sess', messageId: 'm1', queueDepth: 1 });
  expect(useOttoStore.getState().activeSession?.queueDepth).toBe(1);
});
```

- [ ] **Step 4: Run store tests**

Run: `pnpm vitest run src/renderer/state/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `CommandBar.tsx`**

In `src/renderer/components/CommandBar.tsx`:
- Remove `disabled={busy}` and `aria-disabled={busy}` from the input (lines 153-154).
- Keep `busy ? 'text-muted cursor-not-allowed' : 'text-text'` styling driven by *send-button* state only; the textarea stays editable.
- Update `canSend` to `value.trim().length > 0 || attachments.length > 0` (drop `!busy`).
- Update placeholder to: `busy ? 'Otto is working — your message will queue' : 'Ask Otto to do something…'`.
- Add a small queue-depth chip when `queueDepth > 0`: e.g. `<span aria-live="polite" className="text-xs text-muted">{queueDepth} queued</span>`.

- [ ] **Step 6: Pass new props in `App.tsx`**

Replace the `busy` prop with `busy={isSessionBusy(activeSession)} queueDepth={activeSession?.queueDepth ?? 0}` and propagate.

- [ ] **Step 7: Manual UI smoke test**

Run: `pnpm dev` (in another shell)
Steps:
1. Trigger hotkey, ask Otto something that takes >5s (e.g. "take a screenshot and describe it").
2. While the response is streaming, type a second message and submit.
3. Confirm: input was never disabled, second message appears in the transcript immediately as a queued user bubble, and Otto answers it after finishing the first turn. The chip shows `1 queued` between submits.

If the spike (Task 0) showed buffering behavior (b), this works as-is. If it showed (a) interleaving — note the divergence; the UX is the same but the model may answer differently.

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc-contract.ts src/renderer/state/store.ts src/renderer/state/store.test.ts src/renderer/components/CommandBar.tsx src/renderer/App.tsx src/main/agent/session.ts
git commit -m "feat(ui): allow mid-response submits; show queue depth"
```

---

## Task 5: Stop button → `interrupt()`; add Shift+Enter preempt

**Files:**
- Modify: `src/renderer/components/CommandBar.tsx`
- Modify: `src/main/agent/session.ts` (`cancel` → `interrupt`)
- Modify: `src/main/ipc/handlers.ts` (rename IPC route if exposed)
- Modify: `src/main/agent/session.test.ts`

Today `SessionManager.cancel` aborts the per-turn `AbortController`, which kills the whole subprocess. With long-lived streams, that's the wrong primitive — we want `Query.interrupt()`, which ends the *current turn* but keeps the session subprocess running so the queue can keep flowing.

- [ ] **Step 1: Rename `cancel` → `interrupt` on `SessionManager`**

In `src/main/agent/session.ts:211-213`:

```ts
async interrupt(args: { sessionId: string }): Promise<void> {
  const stream = this.streams.get(args.sessionId);
  if (stream) await stream.interrupt();
}
```

Update the IPC handler that calls `.cancel(...)` to call `.interrupt(...)` (search `handlers.ts` for `cancel`).

- [ ] **Step 2: Wire Shift+Enter preempt**

In `CommandBar.tsx`, when `busy === true` and user presses Shift+Enter on submit:
1. Call `onInterruptAndSend(value, attachments)` (new prop).
2. In `App.tsx`, this calls `window.otto.interrupt(sessionId)` then `window.otto.send(...)`.

The plain Enter path enqueues (no interrupt).

- [ ] **Step 3: Add a test for interrupt**

In `session.test.ts`, push two messages, call `interrupt()` between them, assert the fake `Query.interrupt` was called and the second message still flows.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run`
Expected: PASS across the suite.

- [ ] **Step 5: Manual smoke**

Run the dev app, start a long turn, hit Shift+Enter with a new prompt while busy. Confirm Otto cuts the current response and answers the new message immediately.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent/session.ts src/main/ipc/handlers.ts src/renderer/components/CommandBar.tsx src/renderer/App.tsx src/main/agent/session.test.ts
git commit -m "feat(ui): Stop and Shift+Enter map to Query.interrupt()"
```

---

## Task 6: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: all green.

- [ ] **Step 2: Type check**

Run: `pnpm tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Manual concurrency smoke**

In the dev app:
1. Ask Otto to do something with multiple tool calls.
2. While the first tool call is mid-flight, submit a second message (queue it).
3. Submit a third with Shift+Enter (interrupt).
4. Confirm: transcript shows user1 → partial assistant1 → user2 (queued) → user3 (interrupted) → assistant3 → assistant2 (queue resumed). The order may differ depending on the spike result; document what you observe.

- [ ] **Step 4: Commit any test or doc fixups**

```bash
git add -A
git commit -m "test: concurrent input verification"
```

---

## Self-review notes

- **Spec coverage:** queue submission (Task 4), preempt submission (Task 5), long-lived SDK stream (Tasks 1–3), spike to validate the underlying assumption (Task 0).
- **Known caveat:** if Task 0 result is (b) buffering, "mid-response" really means "Otto sees your next message immediately after finishing the current turn" — not literally during the same assistant message. The UI framing of the chip and placeholder is honest about this. If you want strict mid-stream injection, that's Task 5's Shift+Enter (interrupt+resend) path.
- **Out of scope:** parallel sessions (3a from the brainstorm); the `unstable_v2_createSession` API as an alternative to `query()` — worth a follow-up plan once it stabilizes.
