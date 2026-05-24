# Inline Memory-Update Note Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the OS-level "Otto learned N new things" tray notification with a subtle, dense in-conversation note like `2 playbooks, 1 fact created/updated`, persisted to the session's message log.

**Architecture:** Introduce a new `system` message role carrying a `memory-update` content block. The reflection pipeline persists one such message per non-empty reflection via a new `appendSystemNote` dep and emits a new `system-message` SessionEvent so the renderer picks it up live. `TrayManager.notifyLearned` is removed.

**Tech Stack:** TypeScript, Electron IPC, React 18, Zustand store, better-sqlite3, Vitest + Testing Library.

**Reference spec:** `docs/superpowers/specs/2026-05-23-memory-note-inline-design.md`

---

## File map

**Modified:**
- `src/shared/messages.ts` — `SystemMessage`, `memory-update` content block, `newSystemMessage` factory, `isSystemMessage` guard.
- `src/shared/messages.test.ts` — round-trip test for the new shape.
- `src/main/db/repo.ts` — `'system'` branch in `messageBody` + `rowToMessage`.
- `src/main/db/repo.test.ts` — round-trip test.
- `src/shared/ipc-contract.ts` — new `system-message` SessionEvent variant.
- `src/renderer/state/store.ts` — append case in `applyEvent` switch.
- `src/renderer/components/Message.tsx` — render branch for `system` + `memory-update`.
- `src/main/reflection/pipeline.ts` — `PipelineDeps.appendSystemNote`, `PipelineResult.savedByKind`, switch from `notifyLearned` call to `appendSystemNote`.
- `src/main/reflection/pipeline.test.ts` — update notify→appendSystemNote assertions.
- `src/main/index.ts` — drop `notifyLearned`/`tray.notifyLearned`, add `appendSystemNote` closure.
- `src/main/tray.ts` — delete `notifyLearned` method.

No new files. No DB migration (the `role` column is already `TEXT NOT NULL`).

---

## Task 1: SystemMessage shape + repo round-trip

**Files:**
- Modify: `src/shared/messages.ts`
- Modify: `src/shared/messages.test.ts`
- Modify: `src/main/db/repo.ts`
- Modify: `src/main/db/repo.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/shared/messages.test.ts`:

```ts
import {
  isSystemMessage,
  newSystemMessage,
  type SystemMessage,
  type ContentBlock,
} from './messages';

describe('SystemMessage', () => {
  it('newSystemMessage produces a system-role message with the given content', () => {
    const block: ContentBlock = {
      type: 'memory-update',
      facts: 1,
      playbooks: 2,
      antiPatterns: 0,
      heuristics: 1,
    };
    const m: SystemMessage = newSystemMessage([block]);
    expect(m.role).toBe('system');
    expect(m.content).toEqual([block]);
    expect(typeof m.id).toBe('string');
    expect(typeof m.createdAt).toBe('number');
  });

  it('isSystemMessage type guard returns true for system role and false for others', () => {
    const sys = newSystemMessage([
      { type: 'memory-update', facts: 1, playbooks: 0, antiPatterns: 0, heuristics: 0 },
    ]);
    expect(isSystemMessage(sys)).toBe(true);
  });
});
```

Append to `src/main/db/repo.test.ts` (inside the existing `describe('Repo.messages')` or a new sibling describe):

```ts
import { newSystemMessage } from '@shared/messages';

describe('Repo.messages system role', () => {
  it('round-trips a system message with a memory-update content block', () => {
    repo.createSession({ id: 's1', model: 'm', createdAt: 1, lastActive: 1 });
    const sys = {
      ...newSystemMessage([
        { type: 'memory-update' as const, facts: 1, playbooks: 2, antiPatterns: 0, heuristics: 1 },
      ]),
      sessionId: 's1',
    };
    repo.appendMessage(sys);
    const loaded = repo.loadMessages('s1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.role).toBe('system');
    expect(loaded[0]!.content).toEqual([
      { type: 'memory-update', facts: 1, playbooks: 2, antiPatterns: 0, heuristics: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/shared/messages.test.ts src/main/db/repo.test.ts`
Expected: FAIL — `newSystemMessage`, `isSystemMessage`, `SystemMessage` are not exported; repo doesn't know about `'system'` role.

- [ ] **Step 3: Add SystemMessage + memory-update content block + factory + guard**

In `src/shared/messages.ts`:

Extend the `ContentBlock` union (after the `process_output` variant, before the closing `;`):

```ts
  | {
      type: 'memory-update';
      facts: number;
      playbooks: number;
      antiPatterns: number;
      heuristics: number;
    };
```

Add the new message interface after `ToolMessage`:

```ts
export interface SystemMessage extends BaseMessage {
  role: 'system';
}
```

Update the `Message` union:

```ts
export type Message = UserMessage | AssistantMessage | ToolMessage | SystemMessage;
```

Add the factory next to `newAssistantMessage`:

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

Add the type guard at the bottom of the file with the others:

```ts
export const isSystemMessage = (m: Message): m is SystemMessage => m.role === 'system';
```

- [ ] **Step 4: Teach the repo about the `'system'` role**

In `src/main/db/repo.ts`, find `rowToMessage` (currently has branches for `'assistant'`, `'tool'`, defaulting to `'user'`). Replace the function body with:

```ts
function rowToMessage(row: MessageRow): Message {
  const body = JSON.parse(row.content) as MessageBody;
  const base = {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    createdAt: row.created_at,
    content: body.content,
  };
  if (row.role === 'assistant') {
    return {
      ...base,
      role: 'assistant',
      cancelled: body.cancelled ?? false,
      errored: body.errored ?? false,
    };
  }
  if (row.role === 'tool') return { ...base, role: 'tool' };
  if (row.role === 'system') return { ...base, role: 'system' };
  return { ...base, role: 'user' };
}
```

Also update the `MessageRow` interface's `role` field union to include `'system'`:

```ts
interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  created_at: number;
}
```

`messageBody` doesn't need a branch — the default case (just `content`) is correct for system messages.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/shared/messages.test.ts src/main/db/repo.test.ts`
Expected: PASS — new + existing tests green.

- [ ] **Step 6: Commit**

```bash
git add src/shared/messages.ts src/shared/messages.test.ts src/main/db/repo.ts src/main/db/repo.test.ts
git commit -m "$(cat <<'EOF'
feat(messages): SystemMessage role with memory-update content block

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: New `system-message` SessionEvent + store handler

**Files:**
- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/renderer/state/store.ts`

- [ ] **Step 1: Add the SessionEvent variant**

In `src/shared/ipc-contract.ts`, add to the `SessionEvent` union (near the other message-related events like `message-start`):

```ts
  | { type: 'system-message'; sessionId: string; message: Message }
```

`Message` is already imported in this file via the existing `import type { Message } from './messages';` line — no new import needed.

- [ ] **Step 2: Handle the event in the renderer store**

In `src/renderer/state/store.ts`, find the `applyEvent` function's `switch (event.type)` block (around line 106). Add a new case before `case 'message-end':` (any position before `error`/`done` is fine; alongside `message-start` is most thematic):

```ts
case 'system-message': {
  set({
    activeSession: {
      ...session,
      messages: [...session.messages, event.message],
    },
  });
  return;
}
```

This appends the persisted system message into the live message list — same effect as `loadSession` would have on next open.

- [ ] **Step 3: Typecheck + run existing store tests**

Run: `npm run typecheck && npm test -- src/renderer/state/store.test.ts`
Expected: PASS — no existing store test exercises this case yet (added in Task 3).

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-contract.ts src/renderer/state/store.ts
git commit -m "$(cat <<'EOF'
feat(ipc): system-message SessionEvent + renderer store append

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Renderer renders the memory-update note

**Files:**
- Modify: `src/renderer/components/Message.tsx`
- Modify: `src/renderer/components/Message.test.tsx`

`MessageList` already iterates all messages via `MessageView`. Branching for the `system` role happens inside `Message.tsx`.

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/components/Message.test.tsx` (a new `describe` block):

```tsx
import { newSystemMessage } from '@shared/messages';

describe('MessageView system memory-update', () => {
  function renderSystem(counts: {
    facts: number;
    playbooks: number;
    antiPatterns: number;
    heuristics: number;
  }) {
    const msg = {
      ...newSystemMessage([
        { type: 'memory-update' as const, ...counts },
      ]),
      sessionId: 's1',
    };
    return render(<MessageView message={msg} isStreamingTarget={false} />);
  }

  it('renders a single muted line with kinds joined by commas', () => {
    renderSystem({ facts: 1, playbooks: 2, antiPatterns: 0, heuristics: 0 });
    expect(screen.getByText('2 playbooks, 1 fact created/updated')).toBeTruthy();
  });

  it('omits zero-count kinds', () => {
    renderSystem({ facts: 0, playbooks: 0, antiPatterns: 1, heuristics: 0 });
    expect(screen.getByText('1 anti-pattern created/updated')).toBeTruthy();
  });

  it('pluralizes correctly', () => {
    renderSystem({ facts: 3, playbooks: 1, antiPatterns: 2, heuristics: 4 });
    expect(
      screen.getByText('3 facts, 1 playbook, 2 anti-patterns, 4 heuristics created/updated')
    ).toBeTruthy();
  });

  it('renders nothing when all counts are zero', () => {
    const { container } = renderSystem({ facts: 0, playbooks: 0, antiPatterns: 0, heuristics: 0 });
    expect(container.textContent ?? '').toBe('');
  });
});
```

Verify the imports at the top of `Message.test.tsx` include `screen` and `render` from `@testing-library/react`, plus `MessageView` from `./Message`. If they aren't already imported, add them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/components/Message.test.tsx`
Expected: FAIL — `system` role is not handled by `MessageView`, so it either renders nothing or crashes.

- [ ] **Step 3: Add a `system` branch in `MessageView`**

In `src/renderer/components/Message.tsx`, find the existing branches `if (message.role === 'user')` and `if (message.role === 'assistant')`. Add a new branch before them:

```tsx
if (message.role === 'system') {
  const block = message.content[0];
  if (!block || block.type !== 'memory-update') return null;
  const text = formatMemoryUpdate(block);
  if (!text) return null;
  return (
    <div className="text-[11px] text-muted italic py-1 px-3">{text}</div>
  );
}
```

Add the formatter helper at the bottom of the file (outside the `MessageView` function):

```tsx
function formatMemoryUpdate(block: Extract<ContentBlock, { type: 'memory-update' }>): string {
  const parts: string[] = [];
  if (block.playbooks > 0) parts.push(`${block.playbooks} playbook${block.playbooks === 1 ? '' : 's'}`);
  if (block.facts > 0) parts.push(`${block.facts} fact${block.facts === 1 ? '' : 's'}`);
  if (block.antiPatterns > 0) parts.push(`${block.antiPatterns} anti-pattern${block.antiPatterns === 1 ? '' : 's'}`);
  if (block.heuristics > 0) parts.push(`${block.heuristics} heuristic${block.heuristics === 1 ? '' : 's'}`);
  if (parts.length === 0) return '';
  return `${parts.join(', ')} created/updated`;
}
```

Note the order: playbooks → facts → anti-patterns → heuristics. This matches the test's expected output for `{ facts: 1, playbooks: 2 }` → `2 playbooks, 1 fact created/updated`.

If `ContentBlock` is not already imported at the top of `Message.tsx`, add it: the existing line `import type { Message as MessageType, ContentBlock } from '@shared/messages';` already has it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/renderer/components/Message.test.tsx`
Expected: PASS — all 4 new tests plus existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Message.tsx src/renderer/components/Message.test.tsx
git commit -m "$(cat <<'EOF'
feat(renderer): render system memory-update as subtle inline note

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Pipeline switches from notifyLearned to appendSystemNote

**Files:**
- Modify: `src/main/reflection/pipeline.ts`
- Modify: `src/main/reflection/pipeline.test.ts`

- [ ] **Step 1: Rewrite the existing notify-related test assertions**

Open `src/main/reflection/pipeline.test.ts`. Find the existing `ReflectionPipeline.run` tests. The current `PipelineDeps.notifyLearned` becomes `PipelineDeps.appendSystemNote`. Update:

In the test fixture (the `REFLECTOR_OK` factory and beforeEach are unchanged), change the `notify` references:

Find:

```ts
const notify = vi.fn();
const pipeline = new ReflectionPipeline({
  repo,
  artifactRepo,
  configDir: dir,
  runReflector: async () => REFLECTOR_OK(),
  notifyLearned: notify,
});
```

Replace with:

```ts
const appendSystemNote = vi.fn();
const pipeline = new ReflectionPipeline({
  repo,
  artifactRepo,
  configDir: dir,
  runReflector: async () => REFLECTOR_OK(),
  appendSystemNote,
});
```

Apply the same swap (`notify` → `appendSystemNote`, `notifyLearned: notify` → `appendSystemNote`) in every test in the file that currently uses `notify` / `notifyLearned`.

Update the assertions:

- The test `'appends facts to knowledge.md and inserts new artifacts'` currently has `expect(notify).toHaveBeenCalledWith(2);`. Replace with:

```ts
expect(appendSystemNote).toHaveBeenCalledWith('s1', {
  type: 'memory-update',
  facts: 1,
  playbooks: 1,
  antiPatterns: 0,
  heuristics: 0,
});
```

- The test `'does not notify when reflector returns nothing'` currently has `expect(notify).not.toHaveBeenCalled();`. Replace with `expect(appendSystemNote).not.toHaveBeenCalled();`.

- The 500-cap test and the dedup test don't reference notify and stay unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/main/reflection/pipeline.test.ts`
Expected: FAIL — `PipelineDeps` doesn't have an `appendSystemNote` field, and `notifyLearned` is still required.

- [ ] **Step 3: Update `PipelineDeps` and `PipelineResult`**

In `src/main/reflection/pipeline.ts`, replace the `PipelineDeps` and `PipelineResult` interfaces:

```ts
import type { ContentBlock } from '@shared/messages';
// (add this import alongside the existing imports if not present)

export interface PipelineDeps {
  repo: Repo;
  artifactRepo: ArtifactRepo;
  configDir: string;
  runReflector: (prompt: string) => Promise<ReflectOutcome>;
  appendSystemNote: (sessionId: string, content: ContentBlock) => void;
}

export interface PipelineResult {
  savedFacts: number;
  savedArtifacts: number;
  savedByKind: { fact: number; playbook: number; anti_pattern: number; heuristic: number };
  capReached: ArtifactKind[];
  skipped: boolean;
  reason?: string;
}
```

- [ ] **Step 4: Update the body of `ReflectionPipeline.run`**

In the same file, find the kind-iteration loop. After the loop, replace the `notifyLearned`-related block at the end of the method.

Find the existing block (near the end of `run`):

```ts
    const total = novelFacts.length + savedArtifacts;
    if (total > 0) notifyLearned(total);

    return {
      savedFacts: novelFacts.length,
      savedArtifacts,
      capReached,
      skipped: false,
    };
```

Replace with:

```ts
    const savedByKind: PipelineResult['savedByKind'] = {
      fact: novelFacts.length,
      playbook: 0,
      anti_pattern: 0,
      heuristic: 0,
    };
    // We tracked per-kind inserts inside the loop; mirror them here from the
    // outcome arrays (each item that didn't hit the cap got upserted).
    for (const [kind, items] of kindGroups) {
      for (const item of items) {
        const wouldInsertOrUpdate = artifactRepo.list({ kind, limit: HARD_CAP_PER_KIND })
          .some((a) => a.title.toLowerCase() === item.title.toLowerCase());
        if (wouldInsertOrUpdate || counts[kind] <= HARD_CAP_PER_KIND) {
          // Counted regardless of insert-vs-update; capReached items were already filtered.
        }
      }
    }
    // Simpler: track during the loop. Easiest: rewrite the kind-iteration loop
    // to collect savedByKind directly. See note below.

    const total = novelFacts.length + savedArtifacts;
    if (total > 0) {
      appendSystemNote(args.sessionId, {
        type: 'memory-update',
        facts: savedByKind.fact,
        playbooks: savedByKind.playbook,
        antiPatterns: savedByKind.anti_pattern,
        heuristics: savedByKind.heuristic,
      });
    }

    return {
      savedFacts: novelFacts.length,
      savedArtifacts,
      savedByKind,
      capReached,
      skipped: false,
    };
```

Actually that approach double-reads. Replace it with this cleaner version — track `savedByKind` *inside* the loop where each upsert happens. Find the loop:

```ts
    for (const [kind, items] of kindGroups) {
      for (const item of items) {
        const existing = artifactRepo
          .list({ kind, limit: HARD_CAP_PER_KIND })
          .find((a) => a.title.toLowerCase() === item.title.toLowerCase());
        if (!existing && counts[kind] >= HARD_CAP_PER_KIND) {
          if (!capReached.includes(kind)) capReached.push(kind);
          continue;
        }
        try {
          artifactRepo.upsert({
            kind,
            title: item.title,
            body: item.body,
            tags: item.tags,
            sourceSessionId: args.sessionId,
          });
          savedArtifacts += 1;
          if (!existing) counts[kind] += 1;
        } catch (err) {
          logger.error('artifact upsert failed', err);
        }
      }
    }
```

Replace it with this version that also increments `savedByKind`:

```ts
    const savedByKind: PipelineResult['savedByKind'] = {
      fact: novelFacts.length,
      playbook: 0,
      anti_pattern: 0,
      heuristic: 0,
    };

    for (const [kind, items] of kindGroups) {
      for (const item of items) {
        const existing = artifactRepo
          .list({ kind, limit: HARD_CAP_PER_KIND })
          .find((a) => a.title.toLowerCase() === item.title.toLowerCase());
        if (!existing && counts[kind] >= HARD_CAP_PER_KIND) {
          if (!capReached.includes(kind)) capReached.push(kind);
          continue;
        }
        try {
          artifactRepo.upsert({
            kind,
            title: item.title,
            body: item.body,
            tags: item.tags,
            sourceSessionId: args.sessionId,
          });
          savedArtifacts += 1;
          savedByKind[kind] += 1;
          if (!existing) counts[kind] += 1;
        } catch (err) {
          logger.error('artifact upsert failed', err);
        }
      }
    }
```

And after the loop, replace the `notifyLearned` block with:

```ts
    const total = novelFacts.length + savedArtifacts;
    if (total > 0) {
      appendSystemNote(args.sessionId, {
        type: 'memory-update',
        facts: savedByKind.fact,
        playbooks: savedByKind.playbook,
        antiPatterns: savedByKind.anti_pattern,
        heuristics: savedByKind.heuristic,
      });
    }

    return {
      savedFacts: novelFacts.length,
      savedArtifacts,
      savedByKind,
      capReached,
      skipped: false,
    };
```

Also update the early-return path in the same function (the `if (slice.length === 0)` branch and the `if (!outcome.ok)` branch) to include `savedByKind: { fact: 0, playbook: 0, anti_pattern: 0, heuristic: 0 }`. Find:

```ts
    if (slice.length === 0) {
      return { savedFacts: 0, savedArtifacts: 0, capReached: [], skipped: true, reason: 'empty-slice' };
    }
```

Replace with:

```ts
    if (slice.length === 0) {
      return {
        savedFacts: 0,
        savedArtifacts: 0,
        savedByKind: { fact: 0, playbook: 0, anti_pattern: 0, heuristic: 0 },
        capReached: [],
        skipped: true,
        reason: 'empty-slice',
      };
    }
```

And:

```ts
    if (!outcome.ok) {
      logger.warn(`reflector failed: ${outcome.reason}`);
      return { savedFacts: 0, savedArtifacts: 0, capReached: [], skipped: true, reason: outcome.reason };
    }
```

Replace with:

```ts
    if (!outcome.ok) {
      logger.warn(`reflector failed: ${outcome.reason}`);
      return {
        savedFacts: 0,
        savedArtifacts: 0,
        savedByKind: { fact: 0, playbook: 0, anti_pattern: 0, heuristic: 0 },
        capReached: [],
        skipped: true,
        reason: outcome.reason,
      };
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/main/reflection/pipeline.test.ts`
Expected: PASS — all 5 tests (including the two updated assertions).

- [ ] **Step 6: Commit**

```bash
git add src/main/reflection/pipeline.ts src/main/reflection/pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(reflection): pipeline emits appendSystemNote with per-kind counts

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Bootstrap in main; delete tray.notifyLearned

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/tray.ts`

- [ ] **Step 1: Update the pipeline construction in `src/main/index.ts`**

Read the file. Find the `new ReflectionPipeline({...})` construction (around the spot where Task 14 added it). The current `notifyLearned: (n) => tray.notifyLearned(n)` field needs to be replaced.

First, add a `newSystemMessage` import. Find the existing imports at the top of the `startElectron` async function (the dynamic imports). The shared messages aren't imported via dynamic import — they're a normal `import` at the top of the file or unused there. Grep first:

```bash
grep -n "from '@shared/messages'" src/main/index.ts
```

If `newSystemMessage` is not already imported, add to the top-level imports of the file:

```ts
import { newSystemMessage } from '@shared/messages';
```

(Top-level static import is fine — `messages.ts` is tiny and has no electron deps.)

Now change the pipeline construction. Find:

```ts
const pipeline = new ReflectionPipeline({
  repo,
  artifactRepo,
  configDir: ottoConfigDir,
  runReflector: (prompt) =>
    reflect({
      sdk: { run: async (p, _opts) => runReflectorSdk(p) },
      prompt,
      timeoutMs: 60_000,
    }),
  notifyLearned: (n) => tray.notifyLearned(n),
});
```

Replace the `notifyLearned: …` line (the last field of the deps object) with:

```ts
  appendSystemNote: (sessionId, block) => {
    const msg = repo.appendMessage({
      ...newSystemMessage([block]),
      sessionId,
    });
    emitWithNotify({ type: 'system-message', sessionId, message: msg });
  },
```

Resulting block:

```ts
const pipeline = new ReflectionPipeline({
  repo,
  artifactRepo,
  configDir: ottoConfigDir,
  runReflector: (prompt) =>
    reflect({
      sdk: { run: async (p, _opts) => runReflectorSdk(p) },
      prompt,
      timeoutMs: 60_000,
    }),
  appendSystemNote: (sessionId, block) => {
    const msg = repo.appendMessage({
      ...newSystemMessage([block]),
      sessionId,
    });
    emitWithNotify({ type: 'system-message', sessionId, message: msg });
  },
});
```

`emitWithNotify` is the existing closure that wraps `notifier.handle` + `overlay.handleSessionEvent` + `emitSessionEvent` + tray-badge logic. The Notifier and overlay ignore event types they don't recognize, so this is safe.

- [ ] **Step 2: Delete `TrayManager.notifyLearned`**

In `src/main/tray.ts`, remove the entire `notifyLearned(count: number): void { … }` method (the 14-line method that uses Electron `Notification`). Leave `setBadged`, `start`, `refreshMenu`, `destroy`, `iconPath` untouched.

- [ ] **Step 3: Typecheck + run full test suite**

Run: `npm run typecheck && npm test`
Expected: PASS — typecheck flags any remaining references to `tray.notifyLearned` or `notifyLearned` on `PipelineDeps`. Tests stay green (Task 4 already updated pipeline tests; no other test calls `notifyLearned`).

If typecheck or tests fail because something else referenced the removed method (it shouldn't — only `index.ts` used it), fix the remaining reference now.

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev`
- Send a real task to Otto, let it complete, wait 90s for idle reflection (or call `mark_task_complete` from within the model).
- When reflection produces artifacts: confirm a muted italic line appears in the chat at the bottom of the session (e.g., `1 playbook created/updated`).
- Reload Otto / open the same session: confirm the line is still there (persistence).
- Confirm no OS notification fires.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/main/tray.ts
git commit -m "$(cat <<'EOF'
feat(reflection): inline memory note replaces tray notification

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes (already applied above)

- **Spec coverage:**
  - Spec §1 (message shape + rendering) → Tasks 1 (types + repo) and 3 (renderer).
  - Spec §2 (pipeline wiring + SessionEvent + bootstrap + tray removal) → Tasks 2 (event + store), 4 (pipeline), 5 (bootstrap + tray delete).
  - Spec §3 (testing) → tests embedded in Tasks 1, 3, 4. The `tray.test.ts` "remove notifyLearned test if present" item: there's no existing test for the method (it was added without a test), so nothing to remove — Step 3 of Task 5 implicitly verifies via the full suite.
- **Placeholder scan:** every code block is complete; the only contextual lookups (grep for `from '@shared/messages'` in index.ts) are concrete instructions, not TBDs.
- **Type consistency:** `appendSystemNote(sessionId: string, content: ContentBlock)` signature is identical between Task 4 (pipeline) and Task 5 (bootstrap closure). The `memory-update` block shape (`facts, playbooks, antiPatterns, heuristics` — note `antiPatterns` camelCase, `heuristics` plural) is consistent across Tasks 1, 3, 4. `savedByKind` keys use the DB form (`anti_pattern`, snake) while the `memory-update` block uses the JS camelCase form; this asymmetry is intentional — `savedByKind` mirrors `ArtifactKind` (which is `'playbook' | 'anti_pattern' | 'heuristic'`), and the block is what the renderer consumes (idiomatic camelCase). The conversion happens in one place inside Task 4 Step 4.
