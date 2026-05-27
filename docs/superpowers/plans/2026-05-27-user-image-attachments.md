# User Image Attachments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user attach images to a turn — paste, drag-drop, or pick a file on desktop; paste or pick (which surfaces camera + library) on mobile via the WS bridge. Bytes live on disk once; the SDK gets a structured `AsyncIterable<SDKUserMessage>` containing image content blocks materialized from disk just-in-time.

**Architecture:** Extends the existing `ImageRef` content-block pattern with a `source: 'screenshot' | 'user'` discriminator. New `otto-user-image://` Electron protocol serves uploads from `<configDir>/user-uploads/`. Mobile staging uploads images via a new `attach` WS frame before sending the `prompt`.

**Tech Stack:** TypeScript, Electron 33, React 18, Zustand 5, Vitest 2 + jsdom. Existing dependencies only.

**Spec:** `docs/superpowers/specs/2026-05-27-user-image-attachments-design.md`

---

## File Structure

**New files:**
- `src/main/user-uploads/store.ts` — `saveUserUpload(bytes, mimeType, sessionId, configDir): ImageRef`
- `src/main/user-uploads/store.test.ts`

**Modified:**
- `src/shared/messages.ts` — extend `ImageRef`; add `extFromMime`
- `src/shared/ipc-contract.ts` — `SessionSendArgs.attachments?`; `uploads.stage` channel; `RemoteInbound` additions
- `src/main/screenshot/protocol.ts` — broaden `SAFE_FILE`; register `otto-user-image://`
- `src/main/screenshot/cleanup.ts` — rename functions to be root-agnostic (or call existing twice)
- `src/main/agent/session.ts` — accept attachments in `send`
- `src/main/agent/sdk-client.ts` — `sendTurn` switches to `AsyncIterable<SDKUserMessage>` when attachments present
- `src/main/index.ts` — register second protocol; extend orphan sweep
- `src/main/ipc/handlers.ts` — `uploads.stage` handler; extend `settings.resetAllSessions` wipe
- `src/main/remote/session-bus.ts` — `RemoteInbound` additions
- `src/main/remote/bridge-server.ts` — `attach` handler + per-session staging map; extended `prompt`
- `src/renderer/components/CommandBar.tsx` — attachment row, paste/drop/picker
- `src/renderer/components/Message.tsx` — render `image-ref` blocks in user messages
- `src/renderer/state/store.ts` — `appendUserMessage(id, text, attachments?)`
- `src/renderer/App.tsx` — wire attachments through `handleSubmit`
- `src/renderer-remote/wire.ts` — new outbound/inbound frame types
- `src/renderer-remote/chat.tsx` — staging UI, WS attach flow, user-message image rendering

---

## Task 1: Extend `ImageRef` + add `extFromMime`

**Files:**
- Modify: `src/shared/messages.ts`
- Test: `src/shared/messages.test.ts`

The variant currently has fixed `mimeType: 'image/png'` and no `source`. Widen mime to four types, add `source`, add a tiny pure helper.

- [ ] **Step 1: Write failing test**

Append to `src/shared/messages.test.ts`:

```ts
import { extFromMime } from './messages';

it('extFromMime maps every supported mime to a file extension', () => {
  expect(extFromMime('image/png')).toBe('png');
  expect(extFromMime('image/jpeg')).toBe('jpg');
  expect(extFromMime('image/webp')).toBe('webp');
  expect(extFromMime('image/gif')).toBe('gif');
});

it('accepts an image-ref with source: user', () => {
  const block: ContentBlock = {
    type: 'image-ref',
    id: 'abc',
    sessionId: 's1',
    path: '/tmp/x.jpg',
    width: 100, height: 50,
    mimeType: 'image/jpeg',
    source: 'user',
  };
  expect(block.source).toBe('user');
});
```

- [ ] **Step 2: Run test to verify it fails**

`pnpm vitest run src/shared/messages.test.ts`. Expected: FAIL — `extFromMime` not exported; `source` field rejected by union.

- [ ] **Step 3: Implement**

In `src/shared/messages.ts`, replace the `image-ref` variant:

```ts
  | {
      type: 'image-ref';
      id: string;
      sessionId: string;
      path: string;
      width: number;
      height: number;
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      source: 'screenshot' | 'user';
    };
```

Append the helper to the same file:

```ts
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export function extFromMime(m: ImageMimeType): 'png' | 'jpg' | 'webp' | 'gif' {
  switch (m) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
  }
}
```

- [ ] **Step 4: Fix call sites that construct `image-ref` blocks**

The screenshot path in `src/main/agent/sdk-client.ts` (around lines 356-364) currently builds refs without `source`. Add `source: 'screenshot' as const` to that object literal.

The probe test in `src/renderer/state/store.memory-probe.test.ts` (scenario B body) builds refs inline. Add `source: 'screenshot' as const` (or `'user'` — both compile; use `'screenshot'`).

The presenter test in `src/shared/tool-presenters.test.ts` (the `image-ref` assertion case) needs `source` added.

The session-test ref-seeding at `src/main/agent/session.test.ts` (`__setScreenshotRefsForTest` call) needs `source: 'screenshot' as const`.

Run `pnpm typecheck` after each edit; the type error tells you the next call site.

- [ ] **Step 5: Verify**

`pnpm vitest run` (full suite — fast). `pnpm typecheck`. Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/shared/messages.ts src/shared/messages.test.ts \
        src/main/agent/sdk-client.ts src/main/agent/session.test.ts \
        src/shared/tool-presenters.test.ts \
        src/renderer/state/store.memory-probe.test.ts
git commit -m "feat(shared): extend image-ref with source + mimeType union; add extFromMime"
```

---

## Task 2: User-uploads disk store

**Files:**
- Create: `src/main/user-uploads/store.ts`
- Create: `src/main/user-uploads/store.test.ts`

Mirrors `src/main/screenshot/store.ts` but writes to `<configDir>/user-uploads/<sessionId>/` and uses Electron's `nativeImage` to read dimensions from the upload bytes.

- [ ] **Step 1: Write failing tests**

Create `src/main/user-uploads/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveUserUpload, extOf } from './store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'otto-uploads-test-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('saveUserUpload', () => {
  it('writes the bytes under <configDir>/user-uploads/<sessionId>/<uuid>.<ext>', async () => {
    // Minimal valid PNG: 1×1 transparent pixel.
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
      'hex',
    );
    const ref = await saveUserUpload(png, 'image/png', 'sess-1', dir);
    expect(ref.type).toBe('image-ref');
    expect(ref.source).toBe('user');
    expect(ref.sessionId).toBe('sess-1');
    expect(ref.mimeType).toBe('image/png');
    expect(ref.width).toBeGreaterThan(0);
    expect(ref.height).toBeGreaterThan(0);
    const onDisk = readFileSync(ref.path);
    expect(onDisk.equals(png)).toBe(true);
    expect(ref.path).toContain(path.join('user-uploads', 'sess-1'));
    expect(ref.path.endsWith('.png')).toBe(true);
  });

  it('extOf maps every supported mime', () => {
    expect(extOf('image/png')).toBe('png');
    expect(extOf('image/jpeg')).toBe('jpg');
    expect(extOf('image/webp')).toBe('webp');
    expect(extOf('image/gif')).toBe('gif');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

`pnpm vitest run src/main/user-uploads/store.test.ts`. Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/main/user-uploads/store.ts`:

```ts
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeImage } from 'electron';
import type { ContentBlock } from '@shared/messages';
import { extFromMime, type ImageMimeType } from '@shared/messages';

// Re-export so tests have a stable import surface without reaching into @shared.
export const extOf = extFromMime;

export async function saveUserUpload(
  bytes: Buffer,
  mimeType: ImageMimeType,
  sessionId: string,
  configDir: string,
): Promise<Extract<ContentBlock, { type: 'image-ref' }>> {
  const dir = path.join(configDir, 'user-uploads', sessionId);
  await fsp.mkdir(dir, { recursive: true });
  const id = randomUUID();
  const file = path.join(dir, `${id}.${extFromMime(mimeType)}`);
  await fsp.writeFile(file, bytes);
  const img = nativeImage.createFromBuffer(bytes);
  const size = img.getSize();
  return {
    type: 'image-ref',
    id,
    sessionId,
    path: file,
    width: size.width,
    height: size.height,
    mimeType,
    source: 'user',
  };
}
```

- [ ] **Step 4: Verify**

`pnpm vitest run src/main/user-uploads/store.test.ts`. Expected: PASS (2/2). `pnpm typecheck`. Clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/user-uploads/store.ts src/main/user-uploads/store.test.ts
git commit -m "feat(user-uploads): disk store for user image attachments"
```

---

## Task 3: Broaden protocol resolver + register second protocol

**Files:**
- Modify: `src/main/screenshot/protocol.ts`
- Modify: `src/main/screenshot/protocol.test.ts`
- Modify: `src/main/index.ts`

The existing `SAFE_FILE` regex only allows `.png`. Broaden to all four image types. Add `registerOttoUserImageSchemePrivileges` + `registerOttoUserImageProtocol` (siblings of the existing two, calling the same `resolveImageRequest`).

- [ ] **Step 1: Write failing tests**

Append to `src/main/screenshot/protocol.test.ts`:

```ts
it('serves .jpg files', () => {
  const sessDir = path.join(root, 's1');
  writeFileSync(path.join(sessDir, 'photo.jpg'), 'jpg');
  const r = resolveImageRequest('otto-image://s1/photo.jpg', root);
  expect(r.ok).toBe(true);
});
it('serves .jpeg, .webp, .gif files', () => {
  const sessDir = path.join(root, 's1');
  for (const ext of ['jpeg', 'webp', 'gif']) {
    writeFileSync(path.join(sessDir, `x.${ext}`), ext);
    expect(resolveImageRequest(`otto-image://s1/x.${ext}`, root).ok).toBe(true);
  }
});
it('still 404s on non-image extensions', () => {
  expect(resolveImageRequest('otto-image://s1/good.txt', root).ok).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

`pnpm vitest run src/main/screenshot/protocol.test.ts`. Expected: FAIL — new `.jpg` case rejected by current regex.

- [ ] **Step 3: Broaden `SAFE_FILE` + add second protocol helpers**

In `src/main/screenshot/protocol.ts`, change:

```ts
const SAFE_FILE = /^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/;
```

Append:

```ts
export function registerOttoUserImageSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'otto-user-image', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export function registerOttoUserImageProtocol(root: string): void {
  protocol.handle('otto-user-image', (req) => {
    // resolveImageRequest treats hostname as sessionId — same logic, different root.
    const r = resolveImageRequest(req.url.replace('otto-user-image://', 'otto-image://'), root);
    if (!r.ok) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(r.absPath).toString());
  });
}
```

(The URL rewrite is a small shim so the resolver doesn't need to know about scheme variants. Alternative: parameterize the resolver to ignore scheme. The shim is one line and keeps the resolver pure.)

- [ ] **Step 4: Wire into `src/main/index.ts`**

Update the import alongside the existing two:

```ts
const {
  registerOttoImageSchemePrivileges, registerOttoImageProtocol,
  registerOttoUserImageSchemePrivileges, registerOttoUserImageProtocol,
} = await import('./screenshot/protocol');
```

Right after `registerOttoImageSchemePrivileges()` (line ~94), add:

```ts
registerOttoUserImageSchemePrivileges();
```

Right after the existing `registerOttoImageProtocol(path.join(ottoConfigDir, 'screenshots'))` (line ~111), add:

```ts
registerOttoUserImageProtocol(path.join(ottoConfigDir, 'user-uploads'));
```

- [ ] **Step 5: Verify**

`pnpm vitest run src/main/screenshot/protocol.test.ts` and `pnpm typecheck`. All green.

- [ ] **Step 6: Commit**

```bash
git add src/main/screenshot/protocol.ts src/main/screenshot/protocol.test.ts src/main/index.ts
git commit -m "feat(screenshot): broaden image protocol regex; register otto-user-image://"
```

---

## Task 4: Extend cleanup to user-uploads

**Files:**
- Modify: `src/main/screenshot/cleanup.ts` (rename internally — the names still mention "screenshots", but the functions are root-agnostic; rename them or call them twice with different roots)
- Modify: `src/main/index.ts` (orphan sweep also covers user-uploads)
- Modify: `src/main/ipc/handlers.ts` (`settings.resetAllSessions` also wipes user-uploads)
- Test: `src/main/screenshot/cleanup.test.ts` (already exists)

Decision: rename `sweepOrphanScreenshots` → `sweepOrphanSessionFiles` and `wipeAllScreenshots` → `wipeAllSessionFiles`, then call each twice (once per root) at the call sites.

- [ ] **Step 1: Rename the exports**

In `src/main/screenshot/cleanup.ts`, rename both functions. Body is unchanged. Update `src/main/screenshot/cleanup.test.ts` imports + assertions to use the new names.

- [ ] **Step 2: Update call sites**

In `src/main/index.ts` (around line 141-150), replace the single call with:

```ts
const { sweepOrphanSessionFiles } = await import('./screenshot/cleanup');
void (async () => {
  try {
    const sessions = repo.listSessions();
    const known = new Set(sessions.map((s) => s.id));
    await sweepOrphanSessionFiles(path.join(ottoConfigDir, 'screenshots'), known);
    await sweepOrphanSessionFiles(path.join(ottoConfigDir, 'user-uploads'), known);
  } catch (err) {
    console.warn('orphan session-file sweep failed', err);
  }
})();
```

In `src/main/ipc/handlers.ts` (around line 184-185), replace the single wipe call with:

```ts
const { wipeAllSessionFiles } = await import('../screenshot/cleanup');
await wipeAllSessionFiles(path.join(deps.configDir, 'screenshots'));
await wipeAllSessionFiles(path.join(deps.configDir, 'user-uploads'));
```

- [ ] **Step 3: Verify**

`pnpm vitest run`. `pnpm typecheck`. All green.

- [ ] **Step 4: Commit**

```bash
git add src/main/screenshot/cleanup.ts src/main/screenshot/cleanup.test.ts \
        src/main/index.ts src/main/ipc/handlers.ts
git commit -m "feat(cleanup): apply orphan sweep + reset wipe to user-uploads"
```

---

## Task 5: IPC contract + `uploads.stage` handler

**Files:**
- Modify: `src/shared/ipc-contract.ts` (`SessionSendArgs.attachments?`; new channel)
- Modify: `src/main/ipc/handlers.ts` (handler)
- Test: `src/main/ipc/handlers.test.ts` if it exists; otherwise skip — coverage is via integration

- [ ] **Step 1: Extend IPC contract**

In `src/shared/ipc-contract.ts`, find `SessionSendArgs` and change to:

```ts
export interface SessionSendArgs {
  sessionId: string;
  text: string;
  attachments?: Array<Extract<ContentBlock, { type: 'image-ref' }>>;
}
```

Add the new request/response shapes (mirror the existing IPC-channel types in the same file):

```ts
export interface UploadsStageArgs {
  sessionId: string;
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}
export type UploadsStageResult = Extract<ContentBlock, { type: 'image-ref' }>;
```

Register the channel in whatever `IpcContract` map the file maintains. The shape mirrors how `session.send` is wired today — copy the pattern exactly.

- [ ] **Step 2: Add the handler**

In `src/main/ipc/handlers.ts`, add (alongside the existing `session.send` registration around line 63-65):

```ts
ipcMain.handle('uploads.stage', async (_e, args: UploadsStageArgs): Promise<UploadsStageResult> => {
  const { saveUserUpload } = await import('../user-uploads/store');
  return saveUserUpload(Buffer.from(args.bytes), args.mimeType, args.sessionId, deps.configDir);
});
```

Add `Buffer.from(args.bytes)` because Uint8Array arrives via IPC structured-clone but the store expects `Buffer`.

- [ ] **Step 3: Verify**

`pnpm typecheck`. Clean. (No unit test — integration covers this in Task 8.)

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-contract.ts src/main/ipc/handlers.ts
git commit -m "feat(ipc): uploads.stage channel + SessionSendArgs.attachments"
```

---

## Task 6: SessionManager accepts attachments

**Files:**
- Modify: `src/main/agent/session.ts` (`send` method around lines 98-209)
- Test: `src/main/agent/session.test.ts`

- [ ] **Step 1: Write failing test**

Append to `src/main/agent/session.test.ts`:

```ts
it('user message gets text + image-ref content when attachments are passed', async () => {
  const ref: Extract<ContentBlock, { type: 'image-ref' }> = {
    type: 'image-ref', id: 'u1', sessionId: 'sdk-1', path: '/tmp/u1.png',
    width: 10, height: 10, mimeType: 'image/png', source: 'user',
  };
  const { sessionId } = await manager.start({});
  await manager.send({ sessionId, text: 'look', attachments: [ref] });

  const userEvent = events.find((e) => e.type === 'user-message') as Extract<SessionEvent, { type: 'user-message' }>;
  expect(userEvent).toBeDefined();
  // Persisted user message has both blocks.
  const msgs = repo.loadMessages(sessionId);
  const user = msgs.find((m) => m.role === 'user')!;
  expect(user.content).toEqual([{ type: 'text', text: 'look' }, ref]);
});
```

You may need to import `ContentBlock` in the test file.

- [ ] **Step 2: Run test to verify it fails**

`pnpm vitest run src/main/agent/session.test.ts`. Expected: FAIL — `attachments` not accepted.

- [ ] **Step 3: Implement**

In `src/main/agent/session.ts`, change the `send` signature to accept `attachments?: Array<Extract<ContentBlock, { type: 'image-ref' }>>` and build the user message content as `[{type:'text', text}, ...attachments ?? []]`. Where the existing code calls `newUserMessage(text)`, replace with a manual message construction (or extend `newUserMessage` in `src/shared/messages.ts` to accept optional content extras).

Specifically — `newUserMessage` today (in `src/shared/messages.ts:83-92`) hard-codes `content: [{type:'text', text}]`. Update it to:

```ts
export function newUserMessage(text: string, attachments: Array<Extract<ContentBlock, { type: 'image-ref' }>> = []): UserMessage {
  const content: ContentBlock[] = [];
  if (text.length > 0) content.push({ type: 'text', text });
  for (const a of attachments) content.push(a);
  return {
    id: newId('msg'),
    sessionId: null,
    seq: 0,
    createdAt: Date.now(),
    role: 'user',
    content,
  };
}
```

Then in `session.ts#send`, pass `attachments` to `newUserMessage`. Also thread `attachments` through to the SDK call (Task 7).

- [ ] **Step 4: Verify**

`pnpm vitest run src/main/agent`. PASS. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/session.ts src/main/agent/session.test.ts src/shared/messages.ts
git commit -m "feat(session): accept image-ref attachments in user messages"
```

---

## Task 7: SDK switches to `AsyncIterable<SDKUserMessage>` for attachments

**Files:**
- Modify: `src/main/agent/sdk-client.ts` (`sendTurn`, around line 568+)
- Test: `src/main/agent/session.test.ts` (extend the Task 6 test to assert the SDK was invoked with the structured shape)

The SDK accepts `prompt: string | AsyncIterable<SDKUserMessage>` (per `node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/agentSdkTypes.d.ts:31-34`). When no attachments, keep the string path. When attachments present, yield one `SDKUserMessage` whose `message.content` is `[{type:'text', text}, ...image blocks]`. Bytes are read from disk inside the iterator (not before).

- [ ] **Step 1: Write failing test**

In `src/main/agent/session.test.ts`, extend the Task 6 test (or add a new one in the same file):

```ts
it('SDK receives an AsyncIterable prompt when attachments are present', async () => {
  const ref: Extract<ContentBlock, { type: 'image-ref' }> = {
    type: 'image-ref', id: 'u1', sessionId: 'sdk-1', path: '/tmp/u1.png',
    width: 10, height: 10, mimeType: 'image/png', source: 'user',
  };
  // Write a real 1-byte file to disk so the SDK call's fs.readFile succeeds.
  await fsp.writeFile(ref.path, Buffer.from([0]));
  const sendTurnSpy = vi.fn(fakeSdk.sendTurn);
  fakeSdk.sendTurn = sendTurnSpy;
  const { sessionId } = await manager.start({});
  await manager.send({ sessionId, text: 'go', attachments: [ref] });
  const callArgs = sendTurnSpy.mock.calls[0]!;
  // sendTurn signature: (sessionId, text, attachments, signal, resumeId)
  expect(callArgs[2]).toEqual([ref]);
});
```

(`fsp` import from `node:fs` may need to be added.)

- [ ] **Step 2: Run test to verify it fails**

`pnpm vitest run src/main/agent/session.test.ts`. FAIL — `sendTurn` signature doesn't include attachments.

- [ ] **Step 3: Implement**

In `src/main/agent/sdk-client.ts`:

(a) Extend the `SdkClient` interface and `SdkTurn` callers — find `sendTurn(sessionId, text, signal, resumeId)` and change to `sendTurn(sessionId, text, attachments, signal, resumeId)` where `attachments` is `Array<Extract<ContentBlock, { type: 'image-ref' }>>`. Default callers should pass an empty array if they don't have attachments (or the type can mark it optional — either is fine, just keep callers compiling).

(b) In the real implementation of `sendTurn`, branch on attachments:

```ts
async function* events(): AsyncIterable<SdkStreamEvent> {
  yield { type: 'message-start' };
  const sdk = await loadAgentSdk();
  // ... existing setup (MCP server, system prompt, etc.) ...
  const promptInput = attachments.length === 0
    ? text
    : (async function* (): AsyncIterable<unknown /* SDKUserMessage */> {
        const imageBlocks = await Promise.all(attachments.map(async (a) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: a.mimeType,
            data: (await fsp.readFile(a.path)).toString('base64'),
          },
        })));
        const content: unknown[] = [];
        if (text.length > 0) content.push({ type: 'text', text });
        for (const b of imageBlocks) content.push(b);
        yield {
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          session_id: sessionId,
        };
      })();
  const iter = sdk.query({ prompt: promptInput, options: { /* unchanged */ } });
  // ... rest unchanged ...
}
```

Update `session.ts#send` to pass `attachments` (or `[]`) when calling `sdk.sendTurn`.

(c) Update the fake `SdkClient` constructor (the `createFakeSdkClient` function) so its `sendTurn` accepts the new signature.

- [ ] **Step 4: Verify**

`pnpm vitest run`. `pnpm typecheck`. All green.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/sdk-client.ts src/main/agent/session.ts src/main/agent/session.test.ts
git commit -m "feat(sdk): yield AsyncIterable<SDKUserMessage> when attachments are present"
```

---

## Task 8: Desktop CommandBar — paste, drop, file picker, chips

**Files:**
- Modify: `src/renderer/components/CommandBar.tsx`
- Modify: `src/renderer/App.tsx` (signature of `onSubmit` and the `session.send` invoke)
- Modify: `src/renderer/state/store.ts` (`appendUserMessage` accepts attachments)
- Test: `src/renderer/components/CommandBar.test.tsx`

This is the biggest visual change. Keep scope tight: small chip row above the input, paperclip button, hidden file input, paste + drop handlers.

- [ ] **Step 1: Update `appendUserMessage` signature**

In `src/renderer/state/store.ts`, change `appendUserMessage(id, text)` to `appendUserMessage(id, text, attachments)`:

```ts
appendUserMessage(id, text, attachments = []) {
  const session = get().activeSession;
  if (!session) return;
  const content: ContentBlock[] = [];
  if (text.length > 0) content.push({ type: 'text', text });
  for (const a of attachments) content.push(a);
  const msg: UserMessage = { id, sessionId: session.id, seq: session.messages.length, createdAt: Date.now(), role: 'user', content };
  // ... rest unchanged ...
}
```

Update `OttoState`'s `appendUserMessage` type to match. Update any existing callers (likely only `App.tsx`).

- [ ] **Step 2: Update `App.tsx` handleSubmit**

Change `handleSubmit` to receive `{ text, attachments }`:

```ts
async function handleSubmit({ text, attachments }: { text: string; attachments: Array<Extract<ContentBlock,{type:'image-ref'}>> }) {
  // ... existing session id resolution ...
  store.appendUserMessage(crypto.randomUUID(), text, attachments);
  await ipc.invoke('session.send', { sessionId, text, attachments });
}
```

- [ ] **Step 3: Update CommandBar — props + UI + handlers**

Change the `Props` interface:

```ts
interface Props {
  onSubmit(args: { text: string; attachments: Array<Extract<ContentBlock, { type: 'image-ref' }>> }): void;
  onStop?(): void;
  autoFocus?: boolean;
  busy?: boolean;
  welcome?: boolean;
}
```

Inside the component, add state `const [attachments, setAttachments] = useState<ImageRefArray>([])` and a hidden `<input type="file" ref={fileInputRef} accept="image/png,image/jpeg,image/webp,image/gif" multiple style={{display:'none'}}>` plus a paperclip `<button type="button" onClick={() => fileInputRef.current?.click()}>` next to the text input.

A helper that turns a `File` into an `ImageRef`:

```ts
async function stageFile(file: File, sessionId: string) {
  const mimeType = file.type as 'image/png'|'image/jpeg'|'image/webp'|'image/gif';
  if (!['image/png','image/jpeg','image/webp','image/gif'].includes(mimeType)) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ref = await window.otto.invoke('uploads.stage', { sessionId, bytes, mimeType });
  setAttachments((a) => [...a, ref]);
}
```

The `sessionId` is needed before `uploads.stage`. Today the bar doesn't know the sessionId because the session is created on submit. Solution: stage attachments under a placeholder sessionId derived from `crypto.randomUUID()` at first attach, then pass that id all the way through. Actually simpler: lift session creation into App.tsx earlier — when the first attachment is staged or the first key is pressed. Concretely:

- Add `ensureSession(): Promise<string>` to the parent (App.tsx) that returns the active sessionId, creating one if missing. Pass that callback down to CommandBar via a prop. CommandBar calls `await ensureSession()` inside `stageFile` to get the id, then invokes `uploads.stage`.

Wire `onPaste` on the form: walk `e.clipboardData?.items`, for each `kind === 'file' && type.startsWith('image/')` call `item.getAsFile()` then `stageFile(...)`.

Wire `onDragOver` (preventDefault) + `onDrop`: iterate `e.dataTransfer.files`, filter by mime, `stageFile`.

Render attachment chips above the text input:

```tsx
{attachments.length > 0 && (
  <div className="flex gap-1 flex-wrap mb-1">
    {attachments.map((a) => (
      <div key={a.id} className="flex items-center gap-1 px-1.5 py-0.5 bg-bg/60 rounded text-[10px]">
        <img src={`otto-user-image://${a.sessionId}/${a.id}.${extFromMime(a.mimeType)}`} className="h-4 w-4 object-cover rounded" />
        <button onClick={() => setAttachments((s) => s.filter((x) => x.id !== a.id))} aria-label="remove">×</button>
      </div>
    ))}
  </div>
)}
```

`handleSubmit` allows submit when `text.trim().length > 0 || attachments.length > 0`. On submit, call `onSubmit({ text, attachments })` and clear both.

- [ ] **Step 4: Write tests**

Append to `src/renderer/components/CommandBar.test.tsx`:

```ts
it('submits with attachments when only an image is staged', async () => {
  const onSubmit = vi.fn();
  // Mock window.otto.invoke for uploads.stage
  (window as any).otto = { invoke: vi.fn().mockResolvedValue({
    type: 'image-ref', id: 'r1', sessionId: 's1', path: '/tmp/r1.png',
    width: 10, height: 10, mimeType: 'image/png', source: 'user',
  })};
  render(<CommandBar onSubmit={onSubmit} ensureSession={async () => 's1'} />);
  const file = new File([new Uint8Array([0])], 'a.png', { type: 'image/png' });
  // simulate paste
  const form = screen.getByRole('form'); // or whatever the form's role is — adjust
  fireEvent.paste(form, { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } });
  await waitFor(() => {
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledWith({ text: '', attachments: [expect.objectContaining({ id: 'r1' })] });
  });
});
```

Existing CommandBar tests will fail because of the `onSubmit` signature change. Update them to use the new shape.

- [ ] **Step 5: Verify**

`pnpm vitest run src/renderer`. `pnpm typecheck`. All green.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/CommandBar.tsx src/renderer/components/CommandBar.test.tsx \
        src/renderer/App.tsx src/renderer/state/store.ts
git commit -m "feat(commandbar): paste/drop/picker for image attachments"
```

---

## Task 9: Render image-ref in user messages (desktop)

**Files:**
- Modify: `src/renderer/components/Message.tsx`
- Test: `src/renderer/components/Message.test.tsx`

Today `renderText(message.content)` (line 163-168) strips non-text blocks. The user-message renderer needs to walk `content[]` and emit text + image elements in order.

- [ ] **Step 1: Write failing test**

Append to `src/renderer/components/Message.test.tsx`:

```ts
it('renders an image-ref block in a user message via otto-user-image://', () => {
  const message: UserMessage = {
    id: 'm1', sessionId: 's1', seq: 0, createdAt: 0, role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image-ref', id: 'r1', sessionId: 's1', path: '/tmp/r1.png', width: 10, height: 10, mimeType: 'image/png', source: 'user' },
    ],
  };
  render(<Message message={message} />);
  expect(screen.getByText('look')).toBeInTheDocument();
  const img = screen.getByRole('img');
  expect(img.getAttribute('src')).toBe('otto-user-image://s1/r1.png');
});
```

- [ ] **Step 2: Implement**

In `src/renderer/components/Message.tsx`, replace the user-message body so it walks `content[]`:

```tsx
if (message.role === 'user') {
  return (
    <div data-testid="message-user" className="...">
      <div className="...">
        {message.content.map((b, i) => {
          if (b.type === 'text') return <span key={i}>{b.text}</span>;
          if (b.type === 'image-ref') {
            const scheme = b.source === 'user' ? 'otto-user-image' : 'otto-image';
            return <img key={i} src={`${scheme}://${b.sessionId}/${b.id}.${extFromMime(b.mimeType)}`} className="max-w-[200px] rounded mt-1" loading="lazy" />;
          }
          return null;
        })}
      </div>
    </div>
  );
}
```

`renderText` may now be unused — leave it if it's used elsewhere, otherwise remove.

- [ ] **Step 3: Verify**

`pnpm vitest run src/renderer/components/Message.test.tsx`. PASS. `pnpm typecheck` clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/Message.tsx src/renderer/components/Message.test.tsx
git commit -m "feat(message): render image-ref blocks in user messages"
```

---

## Task 10: Mobile wire types + bridge `attach` handler

**Files:**
- Modify: `src/renderer-remote/wire.ts`
- Modify: `src/main/remote/session-bus.ts`
- Modify: `src/main/remote/bridge-server.ts`
- Test: `src/main/remote/bridge-server.test.ts`

- [ ] **Step 1: Extend `RemoteInbound` and wire types**

In `src/main/remote/session-bus.ts`, extend `RemoteInbound`:

```ts
export type RemoteInbound =
  | { type: 'prompt'; sessionId: string; text: string; origin: 'desktop' | 'remote'; attachmentIds?: string[] }
  | { type: 'attach'; sessionId: string; mimeType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif'; bytesBase64: string; clientCorrelationId: string }
  | { type: 'approval'; decisionId: string; decision: 'approve' | 'deny' }
  | { type: 'interrupt'; sessionId: string };
```

In `src/renderer-remote/wire.ts`, add to the outbound frame union something equivalent (sender-side):

```ts
| { v: 1; type: 'attach'; sessionId: string; mimeType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif'; bytesBase64: string; clientCorrelationId: string }
| { v: 1; type: 'prompt'; sessionId: string; text: string; attachmentIds?: string[] }
```

And to the inbound-event branch (in chat.tsx's onEvent or wire.ts's frame types), add:

```ts
| { v: 1; type: 'attach_ok'; clientCorrelationId: string; ref: ImageRef }
| { v: 1; type: 'attach_err'; clientCorrelationId: string; message: string }
```

- [ ] **Step 2: Add staging map + handlers in `bridge-server.ts`**

Add a per-connection staging map (or per-sessionId — per-connection is simpler since the WS session pins both):

```ts
const staged = new Map<string, Map<string, ImageRef>>(); // sessionId → refId → ref
```

Add handler in the WS message switch (around line 140-170):

```ts
} else if (msg.type === 'attach') {
  try {
    const bytes = Buffer.from(msg.bytesBase64, 'base64');
    const ref = await saveUserUpload(bytes, msg.mimeType, msg.sessionId, this.opts.configDir);
    let m = staged.get(msg.sessionId);
    if (!m) { m = new Map(); staged.set(msg.sessionId, m); }
    m.set(ref.id, ref);
    ws.send(JSON.stringify({ v: 1, type: 'attach_ok', clientCorrelationId: msg.clientCorrelationId, ref }));
  } catch (err) {
    ws.send(JSON.stringify({ v: 1, type: 'attach_err', clientCorrelationId: msg.clientCorrelationId, message: String(err) }));
  }
}
```

Update the `prompt` handler to resolve `attachmentIds`:

```ts
} else if (msg.type === 'prompt') {
  const refs = (msg.attachmentIds ?? []).map((id) => staged.get(msg.sessionId)?.get(id)).filter((r): r is ImageRef => !!r);
  // Drop staged entries we just consumed.
  if (refs.length > 0) {
    const m = staged.get(msg.sessionId)!;
    for (const r of refs) m.delete(r.id);
  }
  this.opts.sendPrompt?.(msg.text, 'remote', refs);  // extend the callback signature
}
```

The `sendPrompt` callback signature on `BridgeServerOpts` extends to `(text: string, origin: 'desktop'|'remote', attachments: ImageRef[]) => void`. The wiring in `src/main/index.ts:395` updates to pass attachments through to `sessions.send`.

`this.opts.configDir` must be added to `BridgeServerOpts` (it isn't there today — pass it in from the registration site in `index.ts`).

- [ ] **Step 3: Write failing test**

Append to `src/main/remote/bridge-server.test.ts`:

```ts
it('attach frame stages a file and responds with attach_ok carrying an image-ref', async () => {
  // Use the existing fixture (look at sibling tests for setup pattern).
  // Send an attach frame with a tiny PNG, expect attach_ok with a ref whose
  // id matches the saved file.
  // Then send a prompt frame with that ref id in attachmentIds[], spy on
  // sendPrompt, and assert it received the ref.
});
```

(The test setup in this file is rich; use existing fixtures. Mirror the assertion pattern of nearby tests.)

- [ ] **Step 4: Verify**

`pnpm vitest run src/main/remote`. PASS. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/remote/session-bus.ts src/main/remote/bridge-server.ts \
        src/main/remote/bridge-server.test.ts src/renderer-remote/wire.ts \
        src/main/index.ts
git commit -m "feat(bridge): attach frame + attachmentIds in prompt"
```

---

## Task 11: Mobile chat UI — staging + image rendering

**Files:**
- Modify: `src/renderer-remote/chat.tsx`

- [ ] **Step 1: Add staging UI**

Above the textarea (around line 705-715), add:
- Hidden `<input type="file" accept="image/*" multiple>` (note: `image/*` so iOS/Android both pop the unified picker offering camera + library).
- Paperclip button → triggers the input.
- Paste handler on the textarea.
- A chips row showing staged attachments (image thumbs via `otto-user-image://` URL, × to remove).

When a file is selected/pasted:
- Generate a `clientCorrelationId = crypto.randomUUID()`.
- Build a pending entry `{ correlationId, mimeType, previewBlobUrl }` and add to a `pendingUploads` state.
- Send WS frame `{ v: 1, type: 'attach', sessionId, mimeType, bytesBase64, clientCorrelationId }`.
- In `onEvent` (around line 370-500), handle `attach_ok` by moving the pending entry into `confirmedAttachments: ImageRef[]` keyed by `correlationId`. Handle `attach_err` by removing the pending and showing a toast.

- [ ] **Step 2: Update `onSend`**

Around line 564-575:

```ts
const onSend = () => {
  const trimmed = input.trim();
  if (!trimmed && confirmedAttachments.length === 0) return;
  wsRef.current?.send({
    v: 1,
    type: 'prompt',
    sessionId: sid,
    text: trimmed,
    attachmentIds: confirmedAttachments.map((r) => r.id),
  });
  setInput('');
  setConfirmedAttachments([]);
  setPendingUploads([]);
};
```

Allow send when `pendingUploads.length === 0` (don't send while uploads are still in flight — show the paperclip button as busy).

- [ ] **Step 3: Render image-refs in user messages**

`TranscriptItem.UserItem` today is `{ kind: 'user'; id; text }` — flat text. Two options:

(a) Widen to `{ kind: 'user'; id; content: ContentBlock[] }` and render via per-block switch.
(b) Add a sibling `{ kind: 'user-image'; id; ref: ImageRef }` for image-only segments.

(a) is cleaner and matches the desktop. Update the backfill logic (lines 312-368) to keep the full `content[]` array on each user item rather than extracting text only. Update the renderer (lines 645-656) to walk `content[]`: text → ReactMarkdown, image-ref → `<img>`.

- [ ] **Step 4: Verify**

`pnpm vitest run`. `pnpm typecheck`. All green. Manual smoke via `pnpm dev` if practical (optional).

- [ ] **Step 5: Commit**

```bash
git add src/renderer-remote/chat.tsx
git commit -m "feat(mobile): stage image attachments via WS + render them in user messages"
```

---

## Final verification

- [ ] `pnpm test` — all PASS.
- [ ] `pnpm typecheck` — clean.
- [ ] `pnpm lint` — clean.
- [ ] Manual: `pnpm dev`, paste a screenshot into the bar, send, verify Claude responds about it. Drag a file in, send. Click the paperclip, pick a file, send. On the phone PWA: pair, attach a photo, send.

---

## Notes for the implementer

- Tasks 1–4 are foundation. Tasks 5–7 are the main process / SDK wiring. Tasks 8–9 are desktop UI. Tasks 10–11 are mobile.
- Task 5's IPC channel name `uploads.stage` is convention; if the codebase uses a different namespace (`session.uploads.stage` or similar), match the convention.
- Task 8's `ensureSession` callback prop on CommandBar is the cleanest way to handle the "stage before session exists" problem. If you find an existing pattern in App.tsx that already creates sessions on first activity, reuse it.
- Task 10's `staged` map can grow if a phone uploads images and never sends a prompt. A simple TTL eviction (drop entries older than 10 minutes) is worth adding; do so inside the attach handler at the start (sweep-on-attach, same pattern as process-registry).
