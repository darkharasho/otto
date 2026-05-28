# Topic-Shift Detection — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user submits a new message after 5+ minutes of idle and the new prompt is dissimilar from recent conversation context, show a non-blocking chip suggesting a new conversation. Never auto-switch.

**Architecture:** A pure main-process `TopicShiftDetector` composes the existing `Embedder` and `Repo` to compute cosine similarity between the new prompt and a rolling ~2K-char context window. A renderer-side idle gate (5 min since last user submit) decides whether to call the detector at all; on a positive result, `App.tsx` stages the message and renders a chip with "Start new" / "Keep going". Phase-1 `handleNewConversation` handles the "Start new" branch.

**Tech Stack:** TypeScript, Electron (main + renderer), React, Vitest, `@xenova/transformers` (already wired).

**Spec:** `docs/superpowers/specs/2026-05-27-topic-shift-detection-design.md`

---

## File Structure

**Create:**
- `src/shared/topic-shift-constants.ts` — shared constants used by both main and renderer
- `src/shared/topic-shift-constants.test.ts`
- `src/main/agent/topic-shift-detector.ts` — context window builder, evaluate(), cosine similarity
- `src/main/agent/topic-shift-detector.test.ts`
- `src/renderer/components/TopicShiftChip.tsx` — presentational chip component
- `src/renderer/components/TopicShiftChip.test.tsx`

**Modify:**
- `src/shared/ipc-contract.ts` — add `topicShift.evaluate` channel and arg/result types
- `src/main/ipc/handlers.ts` — register the new handler; accept `TopicShiftDetector` in deps
- `src/main/index.ts` — instantiate `TopicShiftDetector`, pass to `registerIpcHandlers`
- `src/renderer/App.tsx` — refactor `handleSubmit` into wrapper + inner, idle-gate evaluate call, chip rendering

---

## Task 1: Shared constants

**Files:**
- Create: `src/shared/topic-shift-constants.ts`
- Test: `src/shared/topic-shift-constants.test.ts`

- [ ] **Step 1: Write the failing test**

`src/shared/topic-shift-constants.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  IDLE_GATE_MS,
  SIMILARITY_THRESHOLD,
  CONTEXT_WINDOW_CHARS,
  TOPIC_SHIFT_EVALUATE_TIMEOUT_MS,
} from './topic-shift-constants';

describe('topic-shift constants', () => {
  it('IDLE_GATE_MS is 5 minutes', () => {
    expect(IDLE_GATE_MS).toBe(5 * 60 * 1000);
  });

  it('SIMILARITY_THRESHOLD is 0.35', () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.35);
  });

  it('CONTEXT_WINDOW_CHARS is 2000', () => {
    expect(CONTEXT_WINDOW_CHARS).toBe(2000);
  });

  it('TOPIC_SHIFT_EVALUATE_TIMEOUT_MS is 2 seconds', () => {
    expect(TOPIC_SHIFT_EVALUATE_TIMEOUT_MS).toBe(2000);
  });
});
```

- [ ] **Step 2: Verify the test fails**

Run: `pnpm vitest run src/shared/topic-shift-constants.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/shared/topic-shift-constants.ts`:

```ts
export const IDLE_GATE_MS = 5 * 60 * 1000;
export const SIMILARITY_THRESHOLD = 0.35;
export const CONTEXT_WINDOW_CHARS = 2000;
export const TOPIC_SHIFT_EVALUATE_TIMEOUT_MS = 2000;
```

- [ ] **Step 4: Verify the test passes**

Run: `pnpm vitest run src/shared/topic-shift-constants.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/shared/topic-shift-constants.ts src/shared/topic-shift-constants.test.ts
git commit -m "feat(shared): add topic-shift detection constants"
```

---

## Task 2: TopicShiftDetector — context window builder

**Files:**
- Create: `src/main/agent/topic-shift-detector.ts`
- Test: `src/main/agent/topic-shift-detector.test.ts`

This task implements ONLY the context window builder. The `evaluate()` method is added in Task 3.

- [ ] **Step 1: Write the failing test**

`src/main/agent/topic-shift-detector.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Message, UserMessage, AssistantMessage } from '@shared/messages';
import { TopicShiftDetector } from './topic-shift-detector';

function userMsg(text: string, seq: number): UserMessage {
  return {
    id: `u${seq}`,
    sessionId: 's1',
    seq,
    createdAt: 0,
    role: 'user',
    content: [{ type: 'text', text }],
  };
}

function assistantMsg(text: string, seq: number): AssistantMessage {
  return {
    id: `a${seq}`,
    sessionId: 's1',
    seq,
    createdAt: 0,
    role: 'assistant',
    content: [{ type: 'text', text }],
    cancelled: false,
    errored: false,
  };
}

function fakeRepo(messages: Message[]) {
  return { loadMessages: (_sessionId: string) => messages };
}

const noopEmbedder = {
  isAvailable: true,
  async embedBatch(texts: string[]) {
    return texts.map(() => new Float32Array(384));
  },
};

describe('TopicShiftDetector.buildContextWindow', () => {
  it('returns empty string for empty session', () => {
    const d = new TopicShiftDetector({ repo: fakeRepo([]), embedder: noopEmbedder });
    expect(d.buildContextWindow('s1')).toBe('');
  });

  it('returns role-prefixed single user message for a one-message session', () => {
    const d = new TopicShiftDetector({
      repo: fakeRepo([userMsg('hello', 0)]),
      embedder: noopEmbedder,
    });
    expect(d.buildContextWindow('s1')).toBe('user: hello');
  });

  it('joins multiple alternating messages chronologically with role prefixes', () => {
    const d = new TopicShiftDetector({
      repo: fakeRepo([
        userMsg('hi', 0),
        assistantMsg('hey', 1),
        userMsg('how are you', 2),
        assistantMsg('good', 3),
      ]),
      embedder: noopEmbedder,
    });
    expect(d.buildContextWindow('s1')).toBe(
      'user: hi\nassistant: hey\nuser: how are you\nassistant: good',
    );
  });

  it('stops at the next message boundary once the budget is crossed', () => {
    // 5 messages of ~500 chars each = 2500 chars > 2000 budget.
    const long = 'x'.repeat(500);
    const d = new TopicShiftDetector({
      repo: fakeRepo([
        userMsg(long, 0),
        assistantMsg(long, 1),
        userMsg(long, 2),
        assistantMsg(long, 3),
        userMsg(long, 4),
      ]),
      embedder: noopEmbedder,
    });
    const window = d.buildContextWindow('s1');
    // Newest-first accumulation should include the 4 most recent messages
    // (each ~507 chars with prefix). The 5th is dropped.
    expect(window.startsWith('assistant: xxxx')).toBe(true);
    expect(window.endsWith('xxx')).toBe(true);
    // Confirm we don't slice mid-message: the window length should be the
    // exact sum of included messages, not 2000 trimmed.
    const includedLines = window.split('\n');
    expect(includedLines.length).toBeGreaterThanOrEqual(1);
    for (const line of includedLines) {
      expect(line.startsWith('user: ') || line.startsWith('assistant: ')).toBe(true);
    }
  });

  it('includes a single oversized message rather than slicing it', () => {
    const huge = 'a'.repeat(5000);
    const d = new TopicShiftDetector({
      repo: fakeRepo([userMsg(huge, 0)]),
      embedder: noopEmbedder,
    });
    expect(d.buildContextWindow('s1')).toBe(`user: ${huge}`);
  });

  it('skips messages with no text content (tool-only assistant messages)', () => {
    const toolOnlyAssistant: AssistantMessage = {
      id: 'a0',
      sessionId: 's1',
      seq: 0,
      createdAt: 0,
      role: 'assistant',
      content: [{ type: 'tool_use', callId: 'c1', name: 'shell', input: {} }],
      cancelled: false,
      errored: false,
    };
    const d = new TopicShiftDetector({
      repo: fakeRepo([toolOnlyAssistant, userMsg('hello', 1)]),
      embedder: noopEmbedder,
    });
    expect(d.buildContextWindow('s1')).toBe('user: hello');
  });

  it('concatenates multiple text blocks within a single message', () => {
    const u: UserMessage = {
      id: 'u0',
      sessionId: 's1',
      seq: 0,
      createdAt: 0,
      role: 'user',
      content: [
        { type: 'text', text: 'part one' },
        { type: 'text', text: ' part two' },
      ],
    };
    const d = new TopicShiftDetector({ repo: fakeRepo([u]), embedder: noopEmbedder });
    expect(d.buildContextWindow('s1')).toBe('user: part one part two');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/agent/topic-shift-detector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/main/agent/topic-shift-detector.ts`:

```ts
import type { Repo } from '../db/repo';
import type { Embedder } from '../embeddings/embedder';
import type { ContentBlock, Message } from '@shared/messages';
import { CONTEXT_WINDOW_CHARS, SIMILARITY_THRESHOLD } from '@shared/topic-shift-constants';
import { logger } from '../logger';

export interface TopicShiftDetectorDeps {
  repo: Pick<Repo, 'loadMessages'>;
  embedder: Pick<Embedder, 'embedBatch' | 'isAvailable'>;
}

export interface EvaluateResult {
  suggest: boolean;
  similarity: number; // NaN when unavailable or errored
}

export class TopicShiftDetector {
  constructor(private readonly deps: TopicShiftDetectorDeps) {}

  buildContextWindow(sessionId: string): string {
    const messages = this.deps.repo.loadMessages(sessionId);
    if (messages.length === 0) return '';

    // Accumulate newest-first, stop at the message that crosses the budget.
    const collected: string[] = [];
    let total = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      const line = renderMessageLine(m);
      if (line === null) continue;
      collected.push(line);
      total += line.length + 1; // +1 for the joining newline
      if (total >= CONTEXT_WINDOW_CHARS) break;
    }
    // Reverse so the joined string reads chronologically (oldest → newest).
    collected.reverse();
    return collected.join('\n');
  }
}

function renderMessageLine(m: Message): string | null {
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  const text = extractText(m.content);
  if (text.length === 0) return null;
  return `${m.role}: ${text}`;
}

function extractText(content: ContentBlock[]): string {
  let s = '';
  for (const block of content) {
    if (block.type === 'text') s += block.text;
  }
  return s;
}
```

- [ ] **Step 4: Verify the tests pass**

Run: `pnpm vitest run src/main/agent/topic-shift-detector.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/topic-shift-detector.ts src/main/agent/topic-shift-detector.test.ts
git commit -m "feat(agent): TopicShiftDetector context window builder"
```

---

## Task 3: TopicShiftDetector — evaluate()

**Files:**
- Modify: `src/main/agent/topic-shift-detector.ts`
- Modify: `src/main/agent/topic-shift-detector.test.ts`

- [ ] **Step 1: Append the failing tests**

Append to `src/main/agent/topic-shift-detector.test.ts`:

```ts
describe('TopicShiftDetector.evaluate', () => {
  // A fake embedder that returns deterministic vectors keyed by text.
  function makeEmbedder(map: Map<string, number[]>, isAvailable = true) {
    return {
      isAvailable,
      async embedBatch(texts: string[]) {
        return texts.map((t) => {
          const vec = map.get(t);
          if (!vec) throw new Error(`fake embedder: no vector for ${JSON.stringify(t)}`);
          return new Float32Array(vec);
        });
      },
    };
  }

  function fakeRepoWith(messages: Message[]) {
    return { loadMessages: (_id: string) => messages };
  }

  const ALIGNED = [1, 0, 0]; // cosine to itself = 1.0
  const ORTHOGONAL = [0, 1, 0]; // cosine vs ALIGNED = 0.0

  it('returns suggest=false and NaN similarity when embedder is unavailable', async () => {
    const d = new TopicShiftDetector({
      repo: fakeRepoWith([userMsg('hello', 0)]),
      embedder: makeEmbedder(new Map(), false),
    });
    const result = await d.evaluate('s1', 'new prompt');
    expect(result.suggest).toBe(false);
    expect(Number.isNaN(result.similarity)).toBe(true);
  });

  it('returns suggest=false when context window is empty (fresh session)', async () => {
    const d = new TopicShiftDetector({
      repo: fakeRepoWith([]),
      embedder: makeEmbedder(new Map()),
    });
    const result = await d.evaluate('s1', 'anything');
    expect(result.suggest).toBe(false);
  });

  it('returns suggest=true when similarity is clearly below threshold', async () => {
    const messages = [userMsg('about cooking', 0)];
    const map = new Map<string, number[]>([
      ['user: about cooking', ALIGNED],
      ['rocket science', ORTHOGONAL],
    ]);
    const d = new TopicShiftDetector({
      repo: fakeRepoWith(messages),
      embedder: makeEmbedder(map),
    });
    const result = await d.evaluate('s1', 'rocket science');
    expect(result.suggest).toBe(true);
    expect(result.similarity).toBeCloseTo(0.0, 5);
  });

  it('returns suggest=false when similarity is at or above threshold', async () => {
    const messages = [userMsg('about cooking', 0)];
    // Two vectors with cosine similarity exactly above threshold 0.35.
    // Use [1, 0] and [0.5, sqrt(1 - 0.25)] = cosine 0.5.
    const SIMILAR = [0.5, Math.sqrt(0.75), 0];
    const map = new Map<string, number[]>([
      ['user: about cooking', ALIGNED],
      ['more about food', SIMILAR],
    ]);
    const d = new TopicShiftDetector({
      repo: fakeRepoWith(messages),
      embedder: makeEmbedder(map),
    });
    const result = await d.evaluate('s1', 'more about food');
    expect(result.suggest).toBe(false);
    expect(result.similarity).toBeCloseTo(0.5, 5);
  });

  it('treats similarity exactly at threshold as not-a-shift (strict less-than)', async () => {
    const messages = [userMsg('about cooking', 0)];
    // Vector pair with cosine ~ 0.35 exactly.
    const AT_THRESHOLD = [0.35, Math.sqrt(1 - 0.35 * 0.35), 0];
    const map = new Map<string, number[]>([
      ['user: about cooking', ALIGNED],
      ['edge case', AT_THRESHOLD],
    ]);
    const d = new TopicShiftDetector({
      repo: fakeRepoWith(messages),
      embedder: makeEmbedder(map),
    });
    const result = await d.evaluate('s1', 'edge case');
    expect(result.similarity).toBeCloseTo(0.35, 5);
    expect(result.suggest).toBe(false);
  });

  it('returns suggest=false when embedder throws', async () => {
    const messages = [userMsg('about cooking', 0)];
    const throwingEmbedder = {
      isAvailable: true,
      async embedBatch() {
        throw new Error('inference exploded');
      },
    };
    const d = new TopicShiftDetector({
      repo: fakeRepoWith(messages),
      embedder: throwingEmbedder,
    });
    const result = await d.evaluate('s1', 'anything');
    expect(result.suggest).toBe(false);
    expect(Number.isNaN(result.similarity)).toBe(true);
  });
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm vitest run src/main/agent/topic-shift-detector.test.ts`
Expected: FAIL — `evaluate is not a function`.

- [ ] **Step 3: Extend `topic-shift-detector.ts`**

Add the `evaluate` method and `cosineSimilarity` helper. The full file is now:

```ts
import type { Repo } from '../db/repo';
import type { Embedder } from '../embeddings/embedder';
import type { ContentBlock, Message } from '@shared/messages';
import { CONTEXT_WINDOW_CHARS, SIMILARITY_THRESHOLD } from '@shared/topic-shift-constants';
import { logger } from '../logger';

export interface TopicShiftDetectorDeps {
  repo: Pick<Repo, 'loadMessages'>;
  embedder: Pick<Embedder, 'embedBatch' | 'isAvailable'>;
}

export interface EvaluateResult {
  suggest: boolean;
  similarity: number;
}

export class TopicShiftDetector {
  constructor(private readonly deps: TopicShiftDetectorDeps) {}

  buildContextWindow(sessionId: string): string {
    const messages = this.deps.repo.loadMessages(sessionId);
    if (messages.length === 0) return '';
    const collected: string[] = [];
    let total = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      const line = renderMessageLine(m);
      if (line === null) continue;
      collected.push(line);
      total += line.length + 1;
      if (total >= CONTEXT_WINDOW_CHARS) break;
    }
    collected.reverse();
    return collected.join('\n');
  }

  async evaluate(sessionId: string, newPrompt: string): Promise<EvaluateResult> {
    if (!this.deps.embedder.isAvailable) {
      return { suggest: false, similarity: NaN };
    }
    const context = this.buildContextWindow(sessionId);
    if (context.length === 0) {
      return { suggest: false, similarity: NaN };
    }
    try {
      const [ctxVec, promptVec] = await this.deps.embedder.embedBatch([context, newPrompt]);
      if (!ctxVec || !promptVec) {
        return { suggest: false, similarity: NaN };
      }
      const sim = cosineSimilarity(ctxVec, promptVec);
      return { suggest: sim < SIMILARITY_THRESHOLD, similarity: sim };
    } catch (err) {
      logger.warn(`topic-shift evaluate failed: ${err instanceof Error ? err.message : err}`);
      return { suggest: false, similarity: NaN };
    }
  }
}

function renderMessageLine(m: Message): string | null {
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  const text = extractText(m.content);
  if (text.length === 0) return null;
  return `${m.role}: ${text}`;
}

function extractText(content: ContentBlock[]): string {
  let s = '';
  for (const block of content) {
    if (block.type === 'text') s += block.text;
  }
  return s;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return NaN;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return NaN;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

- [ ] **Step 4: Verify the tests pass**

Run: `pnpm vitest run src/main/agent/topic-shift-detector.test.ts`
Expected: PASS — all 13 tests green (7 from Task 2 + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/topic-shift-detector.ts src/main/agent/topic-shift-detector.test.ts
git commit -m "feat(agent): TopicShiftDetector.evaluate with cosine similarity"
```

---

## Task 4: IPC contract — `topicShift.evaluate`

**Files:**
- Modify: `src/shared/ipc-contract.ts`

- [ ] **Step 1: Add the argument and result types**

Open `src/shared/ipc-contract.ts`. After the existing `SessionEnsureForSubmitResult` interface, add:

```ts
export interface TopicShiftEvaluateArgs {
  sessionId: string;
  newPrompt: string;
}

export interface TopicShiftEvaluateResult {
  suggest: boolean;
  similarity: number; // may be NaN if detector was unavailable/errored
}
```

- [ ] **Step 2: Add the channel to the `IpcRequest` union**

Add this entry adjacent to the existing `session.*` channels:

```ts
| {
    channel: 'topicShift.evaluate';
    args: TopicShiftEvaluateArgs;
    result: TopicShiftEvaluateResult;
  }
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS. (Handlers and renderer consumers are wired in Tasks 5 and 6 — adding a channel to the union without a handler is type-legal.)

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-contract.ts
git commit -m "feat(ipc): add topicShift.evaluate channel"
```

---

## Task 5: Wire detector in main + register handler

**Files:**
- Modify: `src/main/ipc/handlers.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Extend `registerIpcHandlers` deps**

In `src/main/ipc/handlers.ts`:

a) Add to imports:

```ts
import type { TopicShiftDetector } from '../agent/topic-shift-detector';
import type {
  // ... existing imports ...
  TopicShiftEvaluateArgs,
  TopicShiftEvaluateResult,
} from '@shared/ipc-contract';
```

b) Add to the `deps` parameter interface:

```ts
topicShiftDetector: TopicShiftDetector;
```

c) Destructure it alongside the other deps:

```ts
const { repo, sessions, window, broker, settings, registry, conversationPolicy, topicShiftDetector } = deps;
```

d) Register the new handler. Add it next to the other `session.*` handlers:

```ts
ipcMain.handle(
  'topicShift.evaluate',
  async (
    _e,
    args: TopicShiftEvaluateArgs,
  ): Promise<TopicShiftEvaluateResult> => {
    return topicShiftDetector.evaluate(args.sessionId, args.newPrompt);
  },
);
```

- [ ] **Step 2: Instantiate the detector in `src/main/index.ts`**

Find where `ConversationPolicy` is instantiated (added in phase 1). Below that, add:

```ts
import { TopicShiftDetector } from './agent/topic-shift-detector';
import { getEmbedder } from './embeddings/embedder';

const topicShiftDetector = new TopicShiftDetector({
  repo,
  embedder: getEmbedder(),
});
```

Then add `topicShiftDetector` to the `registerIpcHandlers({...})` call.

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean; 604+ tests pass (no test was added in this task — we're verifying nothing regressed).

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/handlers.ts src/main/index.ts
git commit -m "feat(agent): instantiate TopicShiftDetector and register IPC handler"
```

---

## Task 6: TopicShiftChip component

**Files:**
- Create: `src/renderer/components/TopicShiftChip.tsx`
- Test: `src/renderer/components/TopicShiftChip.test.tsx`

- [ ] **Step 1: Write the failing tests**

`src/renderer/components/TopicShiftChip.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TopicShiftChip } from './TopicShiftChip';

describe('TopicShiftChip', () => {
  it('renders the suggestion text and both action buttons', () => {
    render(<TopicShiftChip onStartNew={() => {}} onKeepGoing={() => {}} />);
    expect(screen.getByText(/new topic/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start new/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep going/i })).toBeInTheDocument();
  });

  it('calls onStartNew when the Start new button is clicked', async () => {
    const onStartNew = vi.fn();
    const onKeepGoing = vi.fn();
    render(<TopicShiftChip onStartNew={onStartNew} onKeepGoing={onKeepGoing} />);
    await userEvent.click(screen.getByRole('button', { name: /start new/i }));
    expect(onStartNew).toHaveBeenCalledTimes(1);
    expect(onKeepGoing).not.toHaveBeenCalled();
  });

  it('calls onKeepGoing when the Keep going button is clicked', async () => {
    const onStartNew = vi.fn();
    const onKeepGoing = vi.fn();
    render(<TopicShiftChip onStartNew={onStartNew} onKeepGoing={onKeepGoing} />);
    await userEvent.click(screen.getByRole('button', { name: /keep going/i }));
    expect(onKeepGoing).toHaveBeenCalledTimes(1);
    expect(onStartNew).not.toHaveBeenCalled();
  });

  it('calls onKeepGoing when Escape is pressed', () => {
    const onStartNew = vi.fn();
    const onKeepGoing = vi.fn();
    render(<TopicShiftChip onStartNew={onStartNew} onKeepGoing={onKeepGoing} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onKeepGoing).toHaveBeenCalledTimes(1);
    expect(onStartNew).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm vitest run src/renderer/components/TopicShiftChip.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Write the implementation**

`src/renderer/components/TopicShiftChip.tsx`:

```tsx
import { useEffect } from 'react';

interface Props {
  onStartNew(): void;
  onKeepGoing(): void;
}

export function TopicShiftChip({ onStartNew, onKeepGoing }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onKeepGoing();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKeepGoing]);

  return (
    <div
      role="alertdialog"
      aria-label="Topic shift suggestion"
      className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl border border-accent/40 bg-surface/80 text-xs"
    >
      <div className="text-sm text-text">This looks like a new topic.</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onStartNew}
          className="px-2.5 py-1 rounded bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors"
        >
          Start new conversation
        </button>
        <button
          type="button"
          onClick={onKeepGoing}
          className="px-2 py-1 text-xs text-muted hover:text-text transition-colors"
        >
          Keep going
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify the tests pass**

Run: `pnpm vitest run src/renderer/components/TopicShiftChip.test.tsx`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/TopicShiftChip.tsx src/renderer/components/TopicShiftChip.test.tsx
git commit -m "feat(renderer): TopicShiftChip component"
```

---

## Task 7: Renderer wiring in `App.tsx`

**Files:**
- Modify: `src/renderer/App.tsx`

Split `handleSubmit` into a wrapper (does the idle gate + evaluate call) and an inner submit (the actual send). Add `pendingTopicShift` state and render the chip.

- [ ] **Step 1: Add imports and refs**

At the top of `App.tsx`, add:

```ts
import { IDLE_GATE_MS, TOPIC_SHIFT_EVALUATE_TIMEOUT_MS } from '@shared/topic-shift-constants';
import { TopicShiftChip } from './components/TopicShiftChip';
```

Inside the component, alongside the existing `inFlightSessionStart` ref:

```ts
const lastUserSubmitAt = useRef<number>(Date.now());
const [pendingTopicShift, setPendingTopicShift] = useState<
  { text: string; attachments: ImageRef[] } | null
>(null);
```

- [ ] **Step 2: Refactor `handleSubmit` into outer/inner pair**

Replace the existing `handleSubmit` `useCallback` with two callbacks. The inner one does the actual work (no idle gate). The outer one is what `CommandBar.onSubmit` wires to and applies the idle gate.

```ts
const submitToActiveSession = useCallback(
  async ({ text, attachments }: { text: string; attachments: ImageRef[] }) => {
    try {
      setWindowMode('panel');
      void ipc.invoke('window.setMode', { mode: 'panel' });
      const sessionId = await ensureSession();
      appendUserMessage(crypto.randomUUID(), text, attachments);
      console.debug('[otto] session.send', { sessionId, len: text.length, attachments: attachments.length });
      await ipc.invoke('session.send', { sessionId, text, attachments });
      lastUserSubmitAt.current = Date.now();
      void ipc.invoke('session.list', undefined).then(setSessions);
    } catch (err) {
      console.error('[otto] submitToActiveSession failed', err);
    }
  },
  [ensureSession, appendUserMessage, setWindowMode, setSessions],
);

const handleSubmit = useCallback(
  async ({ text, attachments }: { text: string; attachments: ImageRef[] }) => {
    const sessionId = activeSession?.id ?? null;
    const idleMs = Date.now() - lastUserSubmitAt.current;
    // Only consult the detector if we have an active session AND the user has
    // been idle long enough. Fresh-session submits always go straight through.
    if (sessionId && idleMs >= IDLE_GATE_MS) {
      try {
        const result = await Promise.race([
          ipc.invoke('topicShift.evaluate', { sessionId, newPrompt: text }),
          new Promise<{ suggest: false; similarity: number }>((resolve) =>
            setTimeout(() => resolve({ suggest: false, similarity: NaN }), TOPIC_SHIFT_EVALUATE_TIMEOUT_MS),
          ),
        ]);
        if (result.suggest) {
          setPendingTopicShift({ text, attachments });
          return;
        }
      } catch (err) {
        console.warn('[otto] topicShift.evaluate failed; submitting normally', err);
      }
    }
    void submitToActiveSession({ text, attachments });
  },
  [activeSession?.id, submitToActiveSession],
);
```

Note: the existing `handleSubmit` already calls `lastUserSubmitAt.current = Date.now()` indirectly through this rewrite — the inner `submitToActiveSession` updates it after a successful send. That ensures the idle clock only advances on actual sends, not on dropped/chip-cancelled submits.

- [ ] **Step 3: Wire the chip render**

In the panel-mode JSX, find where `<CommandBar ... />` is rendered inside `Panel`'s `footer`. Add the chip above it:

```tsx
footer={
  <div className="flex flex-col gap-2">
    {pendingTopicShift && (
      <TopicShiftChip
        onStartNew={() => {
          const p = pendingTopicShift;
          setPendingTopicShift(null);
          if (p) void handleNewConversation(p);
        }}
        onKeepGoing={() => {
          const p = pendingTopicShift;
          setPendingTopicShift(null);
          if (p) void submitToActiveSession(p);
        }}
      />
    )}
    <CommandBar
      onSubmit={handleSubmit}
      ensureSession={ensureSession}
      ...
    />
    ...
  </div>
}
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean; all tests pass (existing tests should be unaffected — the wrapper preserves the same external behavior when idle gate is not crossed).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(renderer): topic-shift idle gate, evaluate call, and chip wiring"
```

---

## Task 8: Manual smoke test

- [ ] **Step 1: Run the app**

```bash
pnpm dev
```

- [ ] **Step 2: Verify rapid follow-up does not trigger evaluation**

1. Open Otto, send a message about a coding topic (e.g., "what's a closure in JavaScript?").
2. Wait for the full response.
3. Within 60 seconds, send a related follow-up ("can you give an example?").

Expected: no chip. Follow-up lands in the same conversation.

- [ ] **Step 3: Verify same-topic submit after idle does not trigger**

1. After the previous response settles, wait ~6 minutes.
2. Send a related follow-up about the same topic ("what about closures with async?").

Expected: no chip. Follow-up lands in the same conversation. (Threshold gate prevents false positives.)

- [ ] **Step 4: Verify clear topic shift after idle DOES trigger**

1. Wait ~6 minutes since the last user message.
2. Send something obviously unrelated ("what's a good recipe for pasta?").

Expected: chip appears above the input. Two buttons: "Start new conversation" and "Keep going".

- [ ] **Step 5: Verify "Start new" routes correctly**

In the chip, click **Start new conversation**.

Expected:
- Old session is abandoned.
- A fresh session starts.
- The "pasta" message lands as the first message in the new conversation.
- The chip disappears.

- [ ] **Step 6: Verify "Keep going" routes correctly**

Repeat step 4 in a separate session (or after another idle period). When the chip appears, click **Keep going**.

Expected:
- The "pasta" message lands in the current (existing) conversation.
- No new session is created.
- The chip disappears.

- [ ] **Step 7: Verify Escape dismisses the chip (same as Keep going)**

Trigger the chip again, then press Escape.

Expected: same as step 6.

- [ ] **Step 8: Verify embedder-unavailable fail-open**

1. Quit Otto.
2. Restart with `OTTO_DISABLE_EMBEDDINGS=1 pnpm dev`.
3. Reproduce steps 4 (idle + topic shift).

Expected: no chip ever appears. Submit proceeds normally. (Detector short-circuits when embedder is unavailable.)

- [ ] **Step 9: Report**

If all eight checks pass, the feature is ready. Per `superpowers:verification-before-completion`, document each check's pass/fail with a one-line note. Do not claim done until each smoke step has been observed.

---

## Out of Scope (Future Iterations)

The spec lists optional follow-ups deferred from v1:

- Tuning `SIMILARITY_THRESHOLD` based on real false-positive/negative data.
- Hidden settings backdoor for the threshold.
- LLM-judge escalation for similarities in the gray zone (e.g., 0.30–0.40).
- Pre-emptive embedding of the rolling context during idle to eliminate sub-100ms latency.

None of these are required for v1 to ship.
