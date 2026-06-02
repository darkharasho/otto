# Private Conversations (`/p`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/p ` command-bar prefix that starts a private conversation — one that never persists to disk, never feeds reflection, and never writes durable memory.

**Architecture:** A `PrivacyAwareRepo` decorator wraps the existing `Repo` and keeps private sessions entirely in memory (absent from `listSessions`, so no history/residue). Three write paths gate on `repo.isPrivate(id)`: `ReflectionPipeline.run` (skips), `appendKnowledge` (no-ops), and `bumpFactUse` (no-ops). Reads (`recall`, pinned facts) stay enabled.

**Tech Stack:** Electron + React + TypeScript, better-sqlite3, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-06-02-private-conversation-design.md`

---

## File Structure

- `src/shared/manual-prefix.ts` — add `/p ` prefix + parser (alongside `/n `).
- `src/shared/ipc-contract.ts` — add `private?` to `SessionStartArgs` and `SessionEnsureForSubmitArgs`.
- `src/main/db/repo.ts` — add `private?` to `CreateSessionArgs` (base ignores it).
- `src/main/db/privacy-aware-repo.ts` — **new** decorator subclass of `Repo`.
- `src/main/reflection/pipeline.ts` — add `isPrivate` dep + early skip in `run`.
- `src/main/agent/session.ts` — thread `private` through `SessionManager.start`.
- `src/main/ipc/handlers.ts` — type `repo` as `PrivacyAwareRepo`; thread `private` through `session.start` + `session.ensureForSubmit`; `dropPrivate` on `session.close`.
- `src/main/index.ts` — instantiate `PrivacyAwareRepo`; pass `isPrivate` to pipeline; gate `appendKnowledge` + `bumpFactUse`.
- `src/renderer/components/CommandBar.tsx` — add `onPrivateConversation` prop + `/p ` handling.
- `src/renderer/App.tsx` — `handlePrivateConversation`, `pendingPrivate` arming, `ensureSession` threading, wire props.

---

## Task 1: IPC contract + `CreateSessionArgs` flag

**Files:**
- Modify: `src/shared/ipc-contract.ts` (`SessionStartArgs`, `SessionEnsureForSubmitArgs`)
- Modify: `src/main/db/repo.ts` (`CreateSessionArgs`)

- [ ] **Step 1: Add `private?` to the two IPC arg types**

In `src/shared/ipc-contract.ts`:

```ts
export interface SessionStartArgs {
  resume?: string;
  model?: string;
  /** When true, start an ephemeral private session: never persisted, never reflected on. */
  private?: boolean;
}
```

```ts
export interface SessionEnsureForSubmitArgs {
  current: string | null;
  model?: string;
  /** When creating a new session here (current is null / idle timeout), make it private. */
  private?: boolean;
}
```

- [ ] **Step 2: Add `private?` to `CreateSessionArgs`**

In `src/main/db/repo.ts`:

```ts
export interface CreateSessionArgs {
  id: string;
  model: string;
  createdAt: number;
  lastActive: number;
  /** Routed to PrivacyAwareRepo's in-memory store; the base Repo ignores it. */
  private?: boolean;
}
```

The base `Repo.createSession` body is unchanged (it never reads `private`).

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (no usages yet; additive optional fields).

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-contract.ts src/main/db/repo.ts
git commit -m "feat(private): add private flag to session IPC + CreateSessionArgs"
```

---

## Task 2: `/p ` manual prefix

**Files:**
- Modify: `src/shared/manual-prefix.ts`
- Test: `src/shared/manual-prefix.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/shared/manual-prefix.test.ts`:

```ts
import {
  parsePrivateConversationPrefix,
  PRIVATE_CONVERSATION_PREFIX,
} from './manual-prefix';

describe('parsePrivateConversationPrefix', () => {
  it('exports the literal prefix "/p "', () => {
    expect(PRIVATE_CONVERSATION_PREFIX).toBe('/p ');
  });

  it('returns null when buffer does not start with the prefix', () => {
    expect(parsePrivateConversationPrefix('hello')).toBeNull();
    expect(parsePrivateConversationPrefix('say /p now')).toBeNull();
    expect(parsePrivateConversationPrefix('/ping this')).toBeNull();
  });

  it('returns empty remainder when buffer is exactly the prefix', () => {
    expect(parsePrivateConversationPrefix('/p ')).toEqual({ remainder: '' });
  });

  it('returns the trailing text as remainder', () => {
    expect(parsePrivateConversationPrefix('/p secret thing')).toEqual({
      remainder: 'secret thing',
    });
  });

  it('does not match "/p" without a trailing space', () => {
    expect(parsePrivateConversationPrefix('/p')).toBeNull();
    expect(parsePrivateConversationPrefix('/phello')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/shared/manual-prefix.test.ts`
Expected: FAIL — `parsePrivateConversationPrefix` / `PRIVATE_CONVERSATION_PREFIX` not exported.

- [ ] **Step 3: Implement**

Append to `src/shared/manual-prefix.ts`:

```ts
export const PRIVATE_CONVERSATION_PREFIX = '/p ';

export interface ParsedPrivateConversationPrefix {
  remainder: string;
}

export function parsePrivateConversationPrefix(
  buffer: string,
): ParsedPrivateConversationPrefix | null {
  if (!buffer.startsWith(PRIVATE_CONVERSATION_PREFIX)) return null;
  return { remainder: buffer.slice(PRIVATE_CONVERSATION_PREFIX.length) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/shared/manual-prefix.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/manual-prefix.ts src/shared/manual-prefix.test.ts
git commit -m "feat(private): add /p manual prefix parser"
```

---

## Task 3: `CommandBar` private-conversation handling

**Files:**
- Modify: `src/renderer/components/CommandBar.tsx`
- Test: `src/renderer/components/CommandBar.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append two tests inside the `describe('CommandBar', ...)` block in `src/renderer/components/CommandBar.test.tsx`:

```ts
it('fires onPrivateConversation immediately when input value becomes "/p "', async () => {
  const onSubmit = vi.fn();
  const onPrivateConversation = vi.fn();
  render(
    <CommandBar
      onSubmit={onSubmit}
      ensureSession={noopEnsure}
      onPrivateConversation={onPrivateConversation}
    />,
  );
  const input = screen.getByRole('textbox') as HTMLInputElement;
  await userEvent.type(input, '/p ');
  expect(onPrivateConversation).toHaveBeenCalledWith({ text: '', attachments: [] });
  expect(onSubmit).not.toHaveBeenCalled();
  expect(input.value).toBe('');
});

it('routes "/p text" submit to onPrivateConversation with the remainder', async () => {
  const onSubmit = vi.fn();
  const onPrivateConversation = vi.fn();
  render(
    <CommandBar
      onSubmit={onSubmit}
      ensureSession={noopEnsure}
      onPrivateConversation={onPrivateConversation}
    />,
  );
  const input = screen.getByRole('textbox') as HTMLInputElement;
  await userEvent.type(input, '/p hush hush{Enter}');
  expect(onPrivateConversation).toHaveBeenCalledWith({ text: 'hush hush', attachments: [] });
  expect(onSubmit).not.toHaveBeenCalled();
  expect(input.value).toBe('');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/renderer/components/CommandBar.test.tsx`
Expected: FAIL — `onPrivateConversation` not a prop; submit/onChange don't handle `/p `.

- [ ] **Step 3: Implement**

In `src/renderer/components/CommandBar.tsx`:

Update the import to add the private helpers:

```ts
import {
  parseNewConversationPrefix,
  NEW_CONVERSATION_PREFIX,
  parsePrivateConversationPrefix,
  PRIVATE_CONVERSATION_PREFIX,
} from '@shared/manual-prefix';
```

Add to the `Props` interface (next to `onNewConversation`):

```ts
  onPrivateConversation?(args: { text: string; attachments: ImageRef[] }): void;
```

Add `onPrivateConversation` to the destructured props in `CommandBar({ ... })` (next to `onNewConversation`).

In `handleSubmit`, add the private branch immediately after the existing
`onNewConversation` branch (so `/p ` is checked alongside `/n `):

```ts
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const parsedNew = parseNewConversationPrefix(value);
    if (parsedNew && onNewConversation) {
      const remainder = parsedNew.remainder.trimEnd();
      onNewConversation({ text: remainder, attachments });
      setValue('');
      setAttachments([]);
      setSendTick((n) => n + 1);
      inputRef.current?.focus();
      return;
    }
    const parsedPrivate = parsePrivateConversationPrefix(value);
    if (parsedPrivate && onPrivateConversation) {
      const remainder = parsedPrivate.remainder.trimEnd();
      onPrivateConversation({ text: remainder, attachments });
      setValue('');
      setAttachments([]);
      setSendTick((n) => n + 1);
      inputRef.current?.focus();
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 && attachments.length === 0) return;
    onSubmit({ text: trimmed, attachments });
    setValue('');
    setAttachments([]);
    setSendTick((n) => n + 1);
    inputRef.current?.focus();
  }
```

> Note: the existing code names the variable `parsed`; rename it to `parsedNew`
> as shown so the two branches read symmetrically.

In the `<input onChange>` handler, add the immediate-fire private case next to the existing new-conversation one:

```ts
          onChange={(e) => {
            const next = e.target.value;
            if (next === NEW_CONVERSATION_PREFIX && onNewConversation) {
              setValue('');
              setAttachments([]);
              onNewConversation({ text: '', attachments });
              return;
            }
            if (next === PRIVATE_CONVERSATION_PREFIX && onPrivateConversation) {
              setValue('');
              setAttachments([]);
              onPrivateConversation({ text: '', attachments });
              return;
            }
            setValue(next);
          }}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/renderer/components/CommandBar.test.tsx`
Expected: PASS (all CommandBar tests, including the existing `/n ` one).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/CommandBar.tsx src/renderer/components/CommandBar.test.tsx
git commit -m "feat(private): CommandBar handles /p prefix"
```

---

## Task 4: `PrivacyAwareRepo` decorator

**Files:**
- Create: `src/main/db/privacy-aware-repo.ts`
- Test: `src/main/db/privacy-aware-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/db/privacy-aware-repo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from './db';
import { PrivacyAwareRepo } from './privacy-aware-repo';
import { newUserMessage } from '@shared/messages';

let dir: string;
let db: Database;
let repo: PrivacyAwareRepo;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-priv-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  repo = new PrivacyAwareRepo(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('PrivacyAwareRepo', () => {
  it('keeps private sessions out of the database and out of listSessions', () => {
    repo.createSession({ id: 'p1', model: 'm', createdAt: 1, lastActive: 1, private: true });
    expect(repo.isPrivate('p1')).toBe(true);
    // Not in history.
    expect(repo.listSessions().find((s) => s.id === 'p1')).toBeUndefined();
    // Not on disk (query the raw table directly).
    const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get('p1');
    expect(row).toBeUndefined();
    // But readable from memory.
    expect(repo.getSession('p1')?.model).toBe('m');
  });

  it('persists non-private sessions to the database as before', () => {
    repo.createSession({ id: 'n1', model: 'm', createdAt: 1, lastActive: 1 });
    expect(repo.isPrivate('n1')).toBe(false);
    const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get('n1') as { id: string };
    expect(row.id).toBe('n1');
    expect(repo.listSessions().find((s) => s.id === 'n1')).toBeDefined();
  });

  it('stores private messages in memory only, with sequential seq', () => {
    repo.createSession({ id: 'p1', model: 'm', createdAt: 1, lastActive: 1, private: true });
    const a = repo.appendMessage({ ...newUserMessage('first'), sessionId: 'p1' });
    const b = repo.appendMessage({ ...newUserMessage('second'), sessionId: 'p1' });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(repo.loadMessages('p1').map((m) => m.id)).toEqual([a.id, b.id]);
    const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get('p1') as { n: number };
    expect(count.n).toBe(0);
  });

  it('records sdk session id and activity for private sessions in memory', () => {
    repo.createSession({ id: 'p1', model: 'm', createdAt: 1, lastActive: 1, private: true });
    repo.setSdkSessionId('p1', 'sdk-xyz');
    repo.updateSessionActivity('p1', 99, 'idle');
    const meta = repo.getSession('p1')!;
    expect(meta.sdkSessionId).toBe('sdk-xyz');
    expect(meta.lastActive).toBe(99);
    expect(meta.status).toBe('idle');
  });

  it('dropPrivate frees the in-memory session', () => {
    repo.createSession({ id: 'p1', model: 'm', createdAt: 1, lastActive: 1, private: true });
    repo.dropPrivate('p1');
    expect(repo.isPrivate('p1')).toBe(false);
    expect(repo.getSession('p1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/db/privacy-aware-repo.test.ts`
Expected: FAIL — module `./privacy-aware-repo` does not exist.

- [ ] **Step 3: Implement**

Create `src/main/db/privacy-aware-repo.ts`:

```ts
import type { Database } from 'better-sqlite3';
import type { Message, SessionMeta } from '@shared/messages';
import { Repo, type CreateSessionArgs } from './repo';

interface PrivateEntry {
  meta: SessionMeta;
  messages: Message[];
}

/**
 * Decorates {@link Repo}: sessions created with `private: true` live entirely in
 * memory and never touch SQLite. All reads/writes for a private session id are
 * served from the in-memory map; everything else delegates to the base Repo.
 * Private sessions are intentionally absent from `listSessions` so they never
 * appear in history and leave no on-disk residue (even on a crash).
 */
export class PrivacyAwareRepo extends Repo {
  private readonly privateIds = new Set<string>();
  private readonly mem = new Map<string, PrivateEntry>();

  constructor(db: Database) {
    super(db);
  }

  isPrivate(id: string): boolean {
    return this.privateIds.has(id);
  }

  /** Free the in-memory state for a private session (call on session close). No-op otherwise. */
  dropPrivate(id: string): void {
    this.privateIds.delete(id);
    this.mem.delete(id);
  }

  createSession(args: CreateSessionArgs): void {
    if (!args.private) {
      super.createSession(args);
      return;
    }
    this.privateIds.add(args.id);
    this.mem.set(args.id, {
      meta: {
        id: args.id,
        title: null,
        createdAt: args.createdAt,
        lastActive: args.lastActive,
        model: args.model,
        status: 'active',
        sdkSessionId: null,
      },
      messages: [],
    });
  }

  setSdkSessionId(ottoSessionId: string, sdkSessionId: string): void {
    const entry = this.mem.get(ottoSessionId);
    if (entry) {
      entry.meta = { ...entry.meta, sdkSessionId };
      return;
    }
    super.setSdkSessionId(ottoSessionId, sdkSessionId);
  }

  setSessionTitleIfMissing(id: string, title: string): void {
    const entry = this.mem.get(id);
    if (entry) {
      if (entry.meta.title == null) entry.meta = { ...entry.meta, title };
      return;
    }
    super.setSessionTitleIfMissing(id, title);
  }

  updateSessionActivity(id: string, lastActive: number, status: SessionMeta['status']): void {
    const entry = this.mem.get(id);
    if (entry) {
      entry.meta = { ...entry.meta, lastActive, status };
      return;
    }
    super.updateSessionActivity(id, lastActive, status);
  }

  getSession(id: string): SessionMeta | null {
    const entry = this.mem.get(id);
    if (entry) return entry.meta;
    return super.getSession(id);
  }

  loadMessages(sessionId: string): Message[] {
    const entry = this.mem.get(sessionId);
    if (entry) return [...entry.messages];
    return super.loadMessages(sessionId);
  }

  appendMessage(m: Message & { sessionId: string }): Message {
    const entry = this.mem.get(m.sessionId);
    if (!entry) return super.appendMessage(m);
    const existingIdx = entry.messages.findIndex((x) => x.id === m.id);
    if (existingIdx >= 0) {
      const seq = entry.messages[existingIdx]!.seq;
      const updated = { ...m, seq } as Message;
      entry.messages[existingIdx] = updated;
      return updated;
    }
    const seq = entry.messages.length;
    const stored = { ...m, seq } as Message;
    entry.messages.push(stored);
    return stored;
  }
}
```

> `listSessions`, `deleteSessionsOlderThan`, and `deleteAllSessions` are inherited
> unchanged: private sessions aren't on disk, so delegating is correct and keeps
> them out of history.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/main/db/privacy-aware-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/db/privacy-aware-repo.ts src/main/db/privacy-aware-repo.test.ts
git commit -m "feat(private): PrivacyAwareRepo keeps private sessions in memory"
```

---

## Task 5: Reflection pipeline private gate

**Files:**
- Modify: `src/main/reflection/pipeline.ts`
- Test: `src/main/reflection/pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/reflection/pipeline.test.ts`, inside `describe('ReflectionPipeline.run', ...)`:

```ts
it('skips reflection for a private session and never calls the reflector', async () => {
  const runReflector = vi.fn(async () => REFLECTOR_OK());
  const pipeline = new ReflectionPipeline({
    repo,
    artifactRepo,
    factRepo,
    configDir: dir,
    runReflector,
    appendSystemNote: vi.fn(),
    isPrivate: (id) => id === 's1',
  });
  const out = await pipeline.run({ sessionId: 's1', sinceSeq: -1 });
  expect(out.skipped).toBe(true);
  expect(out.reason).toBe('private');
  expect(runReflector).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/reflection/pipeline.test.ts`
Expected: FAIL — `isPrivate` not in `PipelineDeps`; `run` does not short-circuit.

- [ ] **Step 3: Implement**

In `src/main/reflection/pipeline.ts`:

Add `isPrivate` to `PipelineDeps` (optional so existing constructions keep working):

```ts
export interface PipelineDeps {
  repo: Repo;
  artifactRepo: ArtifactRepo;
  factRepo: FactRepo;
  configDir: string;
  runReflector: (prompt: string) => Promise<ReflectOutcome>;
  appendSystemNote: (sessionId: string, content: ContentBlock) => void;
  /** Returns true for private sessions, which must never be reflected on. */
  isPrivate?: (sessionId: string) => boolean;
}
```

At the very top of `run`, before loading messages:

```ts
  async run(args: { sessionId: string; sinceSeq: number }): Promise<PipelineResult> {
    const { repo, artifactRepo, factRepo, runReflector, appendSystemNote, isPrivate } = this.deps;
    if (isPrivate?.(args.sessionId)) {
      return {
        savedFacts: 0,
        savedArtifacts: 0,
        savedByKind: { fact: 0, playbook: 0, anti_pattern: 0, heuristic: 0 },
        capReached: [],
        skipped: true,
        reason: 'private',
      };
    }
    const allMessages = repo.loadMessages(args.sessionId);
    // ...rest unchanged
```

(Keep the rest of the method exactly as-is; just add `isPrivate` to the destructure and the guard block.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/main/reflection/pipeline.test.ts`
Expected: PASS (the new test and all existing pipeline tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/reflection/pipeline.ts src/main/reflection/pipeline.test.ts
git commit -m "feat(private): ReflectionPipeline skips private sessions"
```

---

## Task 6: Thread `private` through `SessionManager.start`

**Files:**
- Modify: `src/main/agent/session.ts:110-126`
- Test: `src/main/agent/session.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/agent/session.test.ts`, inside `describe('SessionManager', ...)`. It builds a manager over a `PrivacyAwareRepo` and asserts a private start stays out of history:

```ts
it('starts a private session that is not persisted to history', async () => {
  const { PrivacyAwareRepo } = await import('../db/privacy-aware-repo');
  const privRepo = new PrivacyAwareRepo(openDatabase(path.join(dir, 'priv.db')));
  const { openStream } = makeFakeOpenStream(async function* () {
    yield { type: 'message-end' };
    yield { type: 'done' };
  });
  const privSdk: SdkClient = { startSession: vi.fn(async () => ({ id: 'sdk-priv' })), openStream };
  const mgr = new SessionManager(privRepo, privSdk, 'claude-sonnet-4-6', () => {});
  const { sessionId } = await mgr.start({ private: true });
  expect(privRepo.isPrivate(sessionId)).toBe(true);
  expect(privRepo.listSessions().find((s) => s.id === sessionId)).toBeUndefined();
  expect(privRepo.getSession(sessionId)?.model).toBe('claude-sonnet-4-6');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/agent/session.test.ts`
Expected: FAIL — `start` does not accept/forward `private`, so `createSession` runs without it and `isPrivate` is false.

- [ ] **Step 3: Implement**

In `src/main/agent/session.ts`, update `start`:

```ts
  async start(args: { resume?: string; model?: string; private?: boolean }): Promise<{ sessionId: string }> {
    const model = args.model ?? this.defaultModel;
    const sdkSession = await this.sdk.startSession({ resume: args.resume, model });
    const now = Date.now();
    if (!this.repo.getSession(sdkSession.id)) {
      this.repo.createSession({
        id: sdkSession.id,
        model,
        createdAt: now,
        lastActive: now,
        private: args.private,
      });
    } else {
      this.repo.updateSessionActivity(sdkSession.id, now, 'active');
    }
    this.activeSessionId = sdkSession.id;
    return { sessionId: sdkSession.id };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/main/agent/session.test.ts`
Expected: PASS (new test + all existing SessionManager tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/session.ts src/main/agent/session.test.ts
git commit -m "feat(private): SessionManager.start forwards private flag"
```

---

## Task 7: Main-process wiring (repo, gates, handlers)

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/handlers.ts`

No new unit tests (this codebase doesn't unit-test `index.ts`/`handlers.ts`; covered by the manual verification in Step 6 and the unit tests from Tasks 4–6).

- [ ] **Step 1: Instantiate `PrivacyAwareRepo`**

In `src/main/index.ts`:

Add the import next to the existing `Repo` import (around line 47):

```ts
  const { Repo } = await import('./db/repo');
  const { PrivacyAwareRepo } = await import('./db/privacy-aware-repo');
```

Change the instantiation at line 125:

```ts
  const repo = new PrivacyAwareRepo(db);
```

(`Repo` may still be imported for types elsewhere; if it becomes unused, drop the import to satisfy lint.)

- [ ] **Step 2: Pass `isPrivate` into the reflection pipeline**

In `src/main/index.ts`, in the `new ReflectionPipeline({ ... })` deps (around line 299), add:

```ts
    isPrivate: (sessionId) => repo.isPrivate(sessionId),
```

- [ ] **Step 3: Gate `appendKnowledge` and `bumpFactUse`**

In `src/main/index.ts`, in the `createRealSdkClient({ ... })` deps:

Wrap `bumpFactUse` (currently `factRepo.bumpUse(ids, sessionId)`):

```ts
    bumpFactUse: (ids, sessionId) => {
      if (repo.isPrivate(sessionId)) return;
      factRepo.bumpUse(ids, sessionId);
    },
```

Wrap `appendKnowledge` (currently writes a fact + regenerates the knowledge file):

```ts
    appendKnowledge: async (note, sessionId) => {
      if (repo.isPrivate(sessionId)) return; // private convos never write durable memory
      await factRepo.upsert({ body: note, preference: true, sourceSessionId: sessionId });
      factRepo.rerank();
      await regenerateKnowledgeFile(ottoConfigDir, factRepo);
    },
```

- [ ] **Step 4: Type `repo` as `PrivacyAwareRepo` in handlers**

In `src/main/ipc/handlers.ts`:

Add the import:

```ts
import type { PrivacyAwareRepo } from '../db/privacy-aware-repo';
```

Change the deps field (line 46) from `repo: Repo;` to:

```ts
  repo: PrivacyAwareRepo;
```

(Leave the `import type { Repo }` line if `Repo` is still referenced; otherwise remove it.)

- [ ] **Step 5: Thread `private` through `session.start`, `session.ensureForSubmit`, and `dropPrivate` on close**

In `src/main/ipc/handlers.ts`:

`session.start` already forwards `args` to `sessions.start(args)` — since `SessionStartArgs` now carries `private`, no change is needed there. Verify it reads:

```ts
  ipcMain.handle('session.start', async (_e, args: SessionStartArgs): Promise<SessionStartResult> => {
    const result = await sessions.start(args);
    conversationPolicy.recordActivity();
    return result;
  });
```

Update `session.ensureForSubmit` to pass `private` when it creates a new session (both the `no-session` and `idle-timeout` branches):

```ts
      const current = args.current;
      if (!current) {
        const { sessionId } = await sessions.start({ model: args.model, private: args.private });
        conversationPolicy.recordActivity();
        return { sessionId, isNew: true, reason: 'no-session' };
      }
      if (conversationPolicy.shouldStartFresh()) {
        const { sessionId } = await sessions.start({ model: args.model, private: args.private });
        conversationPolicy.recordActivity();
        return { sessionId, isNew: true, reason: 'idle-timeout' };
      }
```

Update `session.close` to free private memory after teardown:

```ts
  ipcMain.handle('session.close', async (_e, args: { sessionId: string }): Promise<void> => {
    await sessions.close(args);
    repo.dropPrivate(args.sessionId);
  });
```

- [ ] **Step 6: Typecheck, lint, and full test run**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts src/main/ipc/handlers.ts
git commit -m "feat(private): wire PrivacyAwareRepo, reflection + memory-write gates"
```

---

## Task 8: Renderer wiring (`App.tsx`)

**Files:**
- Modify: `src/renderer/App.tsx`

No new unit test (App.tsx is not unit-tested in this codebase; covered by manual verification).

- [ ] **Step 1: Add a `pendingPrivate` ref**

In `src/renderer/App.tsx`, near the other refs (e.g. `inFlightSessionStart`), add:

```ts
  const pendingPrivate = useRef(false);
```

(Ensure `useRef` is imported from `react`.)

- [ ] **Step 2: Make `ensureSession` propagate and clear the flag**

Update the `ensureSession` callback so the lazily-created session honors a pending private arming:

```ts
  const ensureSession = useCallback(async (): Promise<string> => {
    if (inFlightSessionStart.current) return inFlightSessionStart.current;
    const wantPrivate = pendingPrivate.current;
    const p = ipc
      .invoke('session.ensureForSubmit', {
        current: activeSession?.id ?? null,
        model,
        private: wantPrivate,
      })
      .then(({ sessionId, isNew }) => {
        if (isNew) {
          beginSession(sessionId);
          if (wantPrivate) pendingPrivate.current = false; // consumed
        }
        inFlightSessionStart.current = null;
        return sessionId;
      });
    inFlightSessionStart.current = p;
    return p;
  }, [activeSession, beginSession, model]);
```

> The flag is only cleared when a *new* session is actually created. If
> `ensureForSubmit` reuses the current (non-private) session, the arming carries
> to the next attempt — acceptable for v1; the user just re-arms if needed.

- [ ] **Step 3: Add `handlePrivateConversation`**

Add it right after `handleNewConversation` in `src/renderer/App.tsx`:

```ts
  const handlePrivateConversation = useCallback(
    async ({ text, attachments }: { text: string; attachments: ImageRef[] }) => {
      const prevId = useOttoStore.getState().activeSession?.id ?? null;
      if (prevId) {
        void ipc.invoke('session.close', { sessionId: prevId }).catch(() => {});
      }
      // Empty trigger (the "/p␣" + space case): drop the old session and arm the
      // next submit to be private. From bar/panel, collapse to the bar so the
      // next submit lazily starts a fresh private session via ensureForSubmit.
      if (text.length === 0 && attachments.length === 0) {
        abandonActiveSession();
        pendingPrivate.current = true;
        if (useOttoStore.getState().windowMode !== 'chat') {
          setWindowMode('bar');
          void ipc.invoke('window.setMode', { mode: 'bar' });
        }
        return;
      }
      const { sessionId } = await ipc.invoke('session.start', { model, private: true });
      beginSession(sessionId);
      if (useOttoStore.getState().windowMode === 'bar') {
        setWindowMode('panel');
        void ipc.invoke('window.setMode', { mode: 'panel' });
      }
      appendUserMessage(crypto.randomUUID(), text, attachments);
      await ipc.invoke('session.send', { sessionId, text, attachments });
      // Intentionally do NOT refresh session.list — private sessions stay out of history.
    },
    [abandonActiveSession, beginSession, setWindowMode, appendUserMessage, model],
  );
```

- [ ] **Step 4: Wire the prop into every CommandBar/ChatWindow render site**

In `src/renderer/App.tsx`, add `onPrivateConversation={handlePrivateConversation}` next to each existing `onNewConversation={handleNewConversation}` — the `ChatWindow` render (~line 327), the bar `CommandBar` (~line 341), and the panel `CommandBar` (~line 383).

If `ChatWindow` forwards props to its inner `CommandBar`, add an `onPrivateConversation` prop to `ChatWindow` too and thread it through. Verify by reading `src/renderer/components/ChatWindow.tsx`; mirror exactly how `onNewConversation` is declared and passed.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx src/renderer/components/ChatWindow.tsx
git commit -m "feat(private): App wires /p private conversations end-to-end"
```

---

## Task 9: End-to-end manual verification

**Files:** none (manual).

- [ ] **Step 1: Build and launch**

Run the app per the project's dev launch (e.g. `pnpm dev`). Use the `verify`/`run` skill if available.

- [ ] **Step 2: Verify a private conversation works and stays private**

1. Type `/p remember nothing about this` and send. Confirm Otto responds normally.
2. Open the history sidebar — the private conversation must **not** appear.
3. Inspect the DB: `sqlite3 <ottoConfigDir>/otto.db "SELECT id FROM sessions ORDER BY created_at DESC LIMIT 5;"` — the private session id must be absent, and no new `messages` rows for it.
4. Ask Otto to `knowledge_append` something in the private convo (e.g. "save that my GPU is X"). Confirm no new row appears in the `fact` table and the knowledge markdown file is unchanged.
5. Wait past the reflection idle window (or trigger `mark_task_complete`); confirm no `memory-update` card appears and the log shows the pipeline was skipped with reason `private` (grep the app log for `reflection skipped: private`).

- [ ] **Step 3: Verify `/n ` still behaves as before**

Start a normal `/n ` conversation, confirm it appears in history and (after idle) produces reflection as usual.

- [ ] **Step 4: Verify the bare `/p ` arming path**

Type `/p ` (with trailing space) so the input clears and collapses to the bar, then type a normal message and send. Confirm the resulting session is private (absent from history, no DB rows).

- [ ] **Step 5: Finalize**

If all checks pass, the feature is complete. Use the `superpowers:finishing-a-development-branch` skill to decide on merge/PR.

---

## Notes for the implementer

- **Run tests from the repo root** with `pnpm exec vitest run <path>`.
- **DRY:** the `/p ` branches deliberately mirror the existing `/n ` ones — keep them structurally identical so future changes touch both.
- **Privacy invariant:** the only code that may persist a private session is *none* — if you find yourself adding an `if (private)` branch inside `SessionManager` or `Repo`, stop; the decorator is the single seam.
- **Reads stay enabled:** do **not** gate `recall` or pinned-fact injection — private constrains writes/persistence only.
