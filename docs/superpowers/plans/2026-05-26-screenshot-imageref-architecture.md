# Screenshot ImageRef Architecture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate screenshot base64 retention in renderer Zustand and SessionBus ring (verified leak: +227 MB / 50 screenshots) by routing image bytes through a single on-disk source of truth and a custom `otto-image://` Electron protocol.

**Architecture:** Screenshot bytes are saved to disk once (already true), then represented in all in-process data structures by `ImageRef` content blocks. Bytes only re-materialize at two well-defined boundaries: the MCP tool result for the current turn (read from disk, encoded, dropped), and the renderer `<img>` element (Chromium fetches via custom protocol, manages its own cache). All other layers — `SessionEvent`, SessionBus ring, Zustand store, persisted session JSON — carry refs only.

**Tech Stack:** TypeScript, Electron 33, React 18, Zustand 5, Vitest 2 with jsdom. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-05-26-screenshot-imageref-architecture-design.md`

---

## File Structure

**New files:**
- `src/main/screenshot/protocol.ts` — pure path-resolver + Electron protocol registration (split so the resolver is unit-testable in jsdom; registration runs in real Electron)
- `src/main/screenshot/protocol.test.ts` — resolver tests (path traversal, symlinks, valid path)
- `src/main/screenshot/cleanup.ts` — orphan sweep
- `src/main/screenshot/cleanup.test.ts`

**Modified:**
- `src/shared/messages.ts` — add `ImageRef` block to `ContentBlock`
- `src/shared/tool-presenters.ts` — extend `classifyResult` to recognize `image-ref`
- `src/main/agent/sdk-client.ts` — record ref map in screenshot branch, read bytes from disk
- `src/main/agent/session.ts` — normalize `tool_result.result.content[]` image blocks to refs before emit
- `src/main/index.ts` — register `otto-image` protocol; wire orphan sweep; wipe screenshots root on settings.resetAllSessions
- `src/main/remote/session-bus.ts` — byte cap on ring
- `src/main/shell/process-registry.ts` — evict exited processes after grace
- `src/renderer/state/store.memory-probe.test.ts` — assert <1MB heap growth on ref-based events

**Note on the spec's `session.delete` reference:** there is no per-session delete IPC handler today. Only `settings.resetAllSessions`. Plan reflects this: orphan sweep at startup + wipe-on-reset cover all cases.

---

## Task 1: Add `ImageRef` content block to shared types

**Files:**
- Modify: `src/shared/messages.ts` (add to `ContentBlock` union)
- Test: `src/shared/messages.test.ts` (existing — add a type-discriminator case)

- [ ] **Step 1: Add a failing test for the new variant**

In `src/shared/messages.test.ts`, append:

```ts
import type { ContentBlock } from './messages';

it('accepts an image-ref content block', () => {
  const block: ContentBlock = {
    type: 'image-ref',
    id: '550e8400-e29b-41d4-a716-446655440000',
    sessionId: 's1',
    path: '/tmp/screenshots/s1/foo.png',
    width: 1920,
    height: 1080,
    mimeType: 'image/png',
  };
  expect(block.type).toBe('image-ref');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/shared/messages.test.ts`
Expected: FAIL — `Type '"image-ref"' is not assignable` (or similar TS error during the vitest typecheck phase).

- [ ] **Step 3: Add the `ImageRef` variant**

In `src/shared/messages.ts`, add inside the `ContentBlock` union:

```ts
  | { type: 'image-ref'; id: string; sessionId: string; path: string; width: number; height: number; mimeType: 'image/png' }
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm vitest run src/shared/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/messages.ts src/shared/messages.test.ts
git commit -m "feat(shared): add image-ref content block variant"
```

---

## Task 2: Extend `classifyResult` to detect `image-ref` in tool results

**Files:**
- Modify: `src/shared/tool-presenters.ts:197-232`
- Test: `src/shared/tool-presenters.test.ts`

- [ ] **Step 1: Write failing test**

Append to `src/shared/tool-presenters.test.ts`:

```ts
it('classifies a result containing an image-ref block as an image view', () => {
  const result = {
    content: [
      { type: 'image-ref', id: 'abc', sessionId: 's1', path: '/tmp/x.png', width: 100, height: 50, mimeType: 'image/png' },
      { type: 'text', text: '{"width":100}' },
    ],
  };
  const view = classifyResult('screenshot', result, false);
  expect(view).toEqual({ kind: 'image', src: 'otto-image://s1/abc.png', meta: '100×50' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/shared/tool-presenters.test.ts`
Expected: FAIL — current code returns the base64 inline-image branch (not matching the assertion).

- [ ] **Step 3: Implement the branch**

In `src/shared/tool-presenters.ts`, inside `classifyResult` (around line 222 where `result.content[]` is walked, before the existing base64 source check), add:

```ts
if (typeof result === 'object' && result !== null && Array.isArray((result as { content?: unknown[] }).content)) {
  for (const block of (result as { content: unknown[] }).content) {
    if (
      typeof block === 'object' && block !== null &&
      (block as { type?: unknown }).type === 'image-ref'
    ) {
      const r = block as { id: string; sessionId: string; width?: number; height?: number };
      const meta = typeof r.width === 'number' && typeof r.height === 'number'
        ? `${r.width}×${r.height}` : undefined;
      return meta !== undefined
        ? { kind: 'image', src: `otto-image://${r.sessionId}/${r.id}.png`, meta }
        : { kind: 'image', src: `otto-image://${r.sessionId}/${r.id}.png` };
    }
  }
}
```

Place this block **before** the existing `result.content` base64 check so refs take precedence. Legacy inline `image` blocks still render via the existing branch.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/shared/tool-presenters.test.ts`
Expected: PASS. Also confirm existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/shared/tool-presenters.ts src/shared/tool-presenters.test.ts
git commit -m "feat(presenters): render image-ref blocks via otto-image:// URLs"
```

---

## Task 3: Track per-call ref map in screenshot tool, source bytes from disk

**Files:**
- Modify: `src/main/agent/sdk-client.ts:333-361` (screenshot branch) and ~`:80-110` (top-level state)
- Modify exports so `session.ts` can read the map

The map records refs produced by each tool call. `session.ts` (Task 4) reads it during `tool-call-result` normalization, then deletes the entry. Lives in module scope of `sdk-client.ts` since both the tool implementation and the SDK client live there.

- [ ] **Step 1: Add the map and an exported reader**

Near the top of `src/main/agent/sdk-client.ts` (after existing module-level state), add:

```ts
import { promises as fsp } from 'node:fs';

interface CallRefs { refs: import('@shared/messages').ContentBlock[]; }
const screenshotRefsByCall = new Map<string, CallRefs>();

export function consumeScreenshotRefs(callId: string): import('@shared/messages').ContentBlock[] | null {
  const entry = screenshotRefsByCall.get(callId);
  if (!entry) return null;
  screenshotRefsByCall.delete(callId);
  return entry.refs;
}

// Test seam: lets session.test.ts seed refs without running the full screenshot path.
export function __setScreenshotRefsForTest(callId: string, refs: import('@shared/messages').ContentBlock[]): void {
  screenshotRefsByCall.set(callId, { refs });
}
```

- [ ] **Step 2: Rewrite the screenshot branch to record refs and read bytes from disk**

Replace the existing screenshot block (`sdk-client.ts:333-361`) with:

```ts
if (t.name === 'screenshot') {
  const sArgs = args as { region?: { x: number; y: number; w: number; h: number }; window?: string };
  const captured = await withSelfHidden(() => capture(sArgs, getPlatformAdapter()));
  const tiled = await tileIfNeeded(captured.bytes, MAX_SCREENSHOT_EDGE, MAX_SCREENSHOT_TILES);
  const savedPath = await save(captured.bytes, ctx.sessionId, ctx.getConfigDir());
  // Capture refs in the call map so session.ts can rewrite the published event.
  // Filename stem == id; derive from savedPath so disk + ref agree.
  const baseId = savedPath.split('/').pop()!.replace(/\.png$/, '');
  const refs: import('@shared/messages').ContentBlock[] = tiled.tiles.map((tile, idx) => ({
    type: 'image-ref' as const,
    id: tiled.tiles.length === 1 ? baseId : `${baseId}-${idx}`,
    sessionId: ctx.sessionId,
    path: savedPath, // tiles share the un-tiled source path; renderer fetches the full image
    width: tile.w,
    height: tile.h,
    mimeType: 'image/png' as const,
  }));
  screenshotRefsByCall.set(callId, { refs });
  // Bytes for the current turn's API call (transient — released after yield).
  const tilesForApi = tiled.tiles.map((tile) => ({
    type: 'image' as const,
    data: tile.bytes.toString('base64'),
    mimeType: 'image/png' as const,
  }));
  const meta = {
    path: savedPath,
    width: captured.width,
    height: captured.height,
    monitors: captured.monitors,
    tiles: tiled.tiles.map((tile, index) => ({
      index,
      x: captured.origin.x + tile.x,
      y: captured.origin.y + tile.y,
      w: tile.w,
      h: tile.h,
    })),
  };
  return {
    content: [
      ...tilesForApi,
      { type: 'text' as const, text: JSON.stringify(meta) },
    ],
  };
}
```

Note: tiled tiles' bytes are still produced in memory (sharp/nativeImage already did the work). They live only as long as the `return` value is held by the SDK call, then go out of scope. The Buffers in `captured.bytes` and `tiled.tiles[i].bytes` are not retained by `screenshotRefsByCall`.

- [ ] **Step 3: Write a unit test for `consumeScreenshotRefs`**

Add to `src/main/agent/tools.test.ts` (or a new file `sdk-client.test.ts` if cleaner):

```ts
import { consumeScreenshotRefs } from './sdk-client';

it('consumeScreenshotRefs returns null for unknown call ids', () => {
  expect(consumeScreenshotRefs('does-not-exist')).toBeNull();
});
```

The behavioral test (refs are recorded when screenshot runs) is covered indirectly by Task 4's integration test.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/main/agent`
Expected: existing tests pass; new test passes.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/sdk-client.ts src/main/agent/tools.test.ts
git commit -m "feat(sdk): record image-ref map per screenshot tool call"
```

---

## Task 4: Normalize image content in `session.ts` before publishing `tool-call-result`

**Files:**
- Modify: `src/main/agent/session.ts:130-145`
- Test: `src/main/agent/session.test.ts`

- [ ] **Step 1: Write failing test**

Append to `src/main/agent/session.test.ts` (reusing its `beforeEach` fixtures — `manager`, `events`, `fakeSdk`, etc.):

```ts
import { __setScreenshotRefsForTest } from './sdk-client';

it('rewrites image blocks in tool_result.result.content to image-ref blocks', async () => {
  // Override fakeSdk for this test to yield a tool-call-result with inline image content.
  (fakeSdk.sendTurn as ReturnType<typeof vi.fn>).mockImplementationOnce((_sid, _text, signal) => ({
    signal,
    async *events() {
      yield { type: 'message-start' };
      yield { type: 'tool-call-start', callId: 'cs-1', name: 'screenshot', input: {} };
      yield {
        type: 'tool-call-result',
        callId: 'cs-1',
        isError: false,
        result: {
          content: [
            { type: 'image', data: 'BASE64DATA', mimeType: 'image/png' },
            { type: 'text', text: '{}' },
          ],
        },
      };
      yield { type: 'message-end' };
      yield { type: 'done' };
    },
  }));

  // Seed the per-call ref map as the screenshot tool would have.
  __setScreenshotRefsForTest('cs-1', [
    { type: 'image-ref', id: 'img1', sessionId: 'sdk-1', path: '/tmp/img1.png', width: 100, height: 50, mimeType: 'image/png' },
  ]);

  const { sessionId } = await manager.start({});
  await manager.send({ sessionId, text: 'go' });

  const result = events.find((e) => e.type === 'tool-call-result') as Extract<SessionEvent, { type: 'tool-call-result' }>;
  expect(result).toBeDefined();
  const content = (result.result as { content: unknown[] }).content;
  expect((content[0] as { type: string }).type).toBe('image-ref');
  expect((content[0] as { id: string }).id).toBe('img1');
  // Inline base64 must be gone.
  expect(JSON.stringify(content)).not.toContain('BASE64DATA');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/agent/session.test.ts`
Expected: FAIL — current code emits the tool result verbatim.

- [ ] **Step 3: Add normalization**

In `src/main/agent/session.ts`, modify the `tool-call-result` case (lines 130-145). Replace with:

```ts
case 'tool-call-result': {
  const normalizedResult = normalizeImageBlocks(ev.callId, ev.result);
  assistant.content.push({
    type: 'tool_result',
    callId: ev.callId,
    result: normalizedResult,
    isError: ev.isError,
  });
  this.emit({
    type: 'tool-call-result',
    sessionId,
    messageId: assistant.id,
    callId: ev.callId,
    result: normalizedResult,
    isError: ev.isError,
  });
  break;
}
```

Add the helper at the top of the file:

```ts
import { consumeScreenshotRefs } from './sdk-client';

function normalizeImageBlocks(callId: string, result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const r = result as { content?: unknown[] };
  if (!Array.isArray(r.content)) return result;
  const refs = consumeScreenshotRefs(callId);
  if (!refs) return result;
  // Replace image blocks in positional order with the recorded refs.
  let refIdx = 0;
  const nextContent = r.content.map((block) => {
    if (
      typeof block === 'object' && block !== null &&
      (block as { type?: unknown }).type === 'image' &&
      refIdx < refs.length
    ) {
      return refs[refIdx++];
    }
    return block;
  });
  return { ...r, content: nextContent };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/agent/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/session.ts src/main/agent/session.test.ts
git commit -m "feat(session): rewrite image blocks to image-ref before publishing events"
```

---

## Task 5a: Pure path-resolver for `otto-image://`

**Files:**
- Create: `src/main/screenshot/protocol.ts`
- Create: `src/main/screenshot/protocol.test.ts`

Splitting the resolver from `protocol.handle` registration: the resolver is a pure function `(url, root) → { ok: true; absPath } | { ok: false; status: 404 }` and runs in vitest's jsdom env. Registration uses Electron's `protocol` API and is wired in `main/index.ts` (Task 5b) but not unit-tested.

- [ ] **Step 1: Write failing tests**

Create `src/main/screenshot/protocol.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveImageRequest } from './protocol';

let root: string;
let outsideRoot: string;

beforeAll(() => {
  outsideRoot = mkdtempSync(path.join(os.tmpdir(), 'otto-outside-'));
  writeFileSync(path.join(outsideRoot, 'secret.png'), 'evil');
  root = mkdtempSync(path.join(os.tmpdir(), 'otto-shots-'));
  const sessDir = path.join(root, 's1');
  // recursive mkdir
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('node:fs').mkdirSync(sessDir, { recursive: true });
  writeFileSync(path.join(sessDir, 'good.png'), 'png');
  symlinkSync(path.join(outsideRoot, 'secret.png'), path.join(sessDir, 'evil.png'));
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outsideRoot, { recursive: true, force: true });
});

describe('resolveImageRequest', () => {
  it('serves a valid file', () => {
    const r = resolveImageRequest('otto-image://s1/good.png', root);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.absPath).toBe(path.join(root, 's1', 'good.png'));
  });
  it('404s on path traversal in segment', () => {
    expect(resolveImageRequest('otto-image://s1/..%2Fevil.png', root).ok).toBe(false);
  });
  it('404s on missing file', () => {
    expect(resolveImageRequest('otto-image://s1/missing.png', root).ok).toBe(false);
  });
  it('404s on bad sessionId', () => {
    expect(resolveImageRequest('otto-image://has spaces/good.png', root).ok).toBe(false);
  });
  it('404s on non-png extension', () => {
    expect(resolveImageRequest('otto-image://s1/good.txt', root).ok).toBe(false);
  });
  it('404s on symlink pointing outside root', () => {
    expect(resolveImageRequest('otto-image://s1/evil.png', root).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/screenshot/protocol.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the resolver**

Create `src/main/screenshot/protocol.ts`:

```ts
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export type ResolveResult =
  | { ok: true; absPath: string }
  | { ok: false; status: 404 };

const SAFE_SESSION = /^[A-Za-z0-9_-]+$/;
const SAFE_FILE = /^[A-Za-z0-9_-]+\.png$/;

export function resolveImageRequest(rawUrl: string, root: string): ResolveResult {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { ok: false, status: 404 }; }
  const sessionId = url.hostname;
  const file = url.pathname.replace(/^\//, '');
  if (!SAFE_SESSION.test(sessionId)) return { ok: false, status: 404 };
  if (!SAFE_FILE.test(file)) return { ok: false, status: 404 };
  const abs = path.join(root, sessionId, file);
  if (!existsSync(abs)) return { ok: false, status: 404 };
  let real: string;
  try { real = realpathSync(abs); } catch { return { ok: false, status: 404 }; }
  const rootReal = realpathSync(root);
  if (!real.startsWith(rootReal + path.sep)) return { ok: false, status: 404 };
  return { ok: true, absPath: real };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/screenshot/protocol.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/main/screenshot/protocol.ts src/main/screenshot/protocol.test.ts
git commit -m "feat(screenshot): pure resolver for otto-image:// requests"
```

---

## Task 5b: Register `otto-image` protocol in main

**Files:**
- Modify: `src/main/index.ts:93,107-108` area (or wherever protocol registration currently lives)
- Add: `src/main/screenshot/protocol.ts` — export `registerOttoImageProtocol(root)`

- [ ] **Step 1: Add the registration helper**

Append to `src/main/screenshot/protocol.ts`:

```ts
import { protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';

export function registerOttoImageSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'otto-image', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export function registerOttoImageProtocol(root: string): void {
  protocol.handle('otto-image', (req) => {
    const r = resolveImageRequest(req.url, root);
    if (!r.ok) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(r.absPath).toString());
  });
}
```

- [ ] **Step 2: Wire registration in `src/main/index.ts`**

Near the existing `registerImageProtocolPrivileges()` call (line 93), add:

```ts
import { registerOttoImageSchemePrivileges, registerOttoImageProtocol } from './screenshot/protocol';
import path from 'node:path';
// ...
registerImageProtocolPrivileges();
registerOttoImageSchemePrivileges();
```

After `app.whenReady()` (near line 107-108):

```ts
registerOttoImageProtocol(path.join(ottoConfigDir, 'screenshots'));
```

- [ ] **Step 3: Manual smoke test**

Run: `pnpm dev`. In the running app, trigger a screenshot via Otto. Verify in the renderer DevTools that the image element loads from `otto-image://...` and no base64 data URI is in the DOM. If it doesn't load, check main-process logs.

(Skip if dev env can't be brought up; the resolver tests + per-task integration tests give coverage. Manual verification is the only check for the Electron-side registration.)

- [ ] **Step 4: Commit**

```bash
git add src/main/screenshot/protocol.ts src/main/index.ts
git commit -m "feat(main): register otto-image:// protocol handler"
```

---

## Task 6: SessionBus byte cap

**Files:**
- Modify: `src/main/remote/session-bus.ts:22-72`
- Test: `src/main/remote/session-bus.test.ts` (create if absent)

- [ ] **Step 1: Write failing test**

Create or extend `src/main/remote/session-bus.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SessionBus } from './session-bus';

it('drops oldest events when ring exceeds byte cap', () => {
  const bus = new SessionBus({ maxBytesPerSession: 1024 });
  for (let i = 0; i < 100; i++) {
    bus.publish('s1', { type: 'event', kind: 'noise', payload: 'x'.repeat(64) });
  }
  const { events } = bus.history('s1', 0);
  const totalBytes = events.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
  expect(totalBytes).toBeLessThanOrEqual(1024 * 2); // generous upper bound (estimator slack)
  expect(events.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/remote/session-bus.test.ts`
Expected: FAIL — constructor option does not exist.

- [ ] **Step 3: Implement byte cap**

In `src/main/remote/session-bus.ts`:

```ts
export interface SessionBusOpts { ringSize?: number; maxBytesPerSession?: number; now?: () => number }

// inside the class:
private readonly maxBytesPerSession: number;
private readonly ringBytes = new Map<string, number>();

constructor(opts: SessionBusOpts = {}) {
  this.ringSize = opts.ringSize ?? 200;
  this.maxBytesPerSession = opts.maxBytesPerSession ?? 8 * 1024 * 1024;
  this.now = opts.now ?? Date.now;
}
```

Modify `publish`:

```ts
publish(sessionId: string, event: RemoteOutbound): void {
  const seq = (this.seqs.get(sessionId) ?? 0) + 1;
  this.seqs.set(sessionId, seq);
  const entry: RingEntry = { seq, event, t: this.now() };
  const entryBytes = JSON.stringify(entry).length;
  let ring = this.ring.get(sessionId);
  if (!ring) { ring = []; this.ring.set(sessionId, ring); }
  ring.push(entry);
  let bytes = (this.ringBytes.get(sessionId) ?? 0) + entryBytes;
  while ((ring.length > this.ringSize || bytes > this.maxBytesPerSession) && ring.length > 0) {
    const dropped = ring.shift()!;
    bytes -= JSON.stringify(dropped).length;
  }
  this.ringBytes.set(sessionId, Math.max(0, bytes));
  const subs = this.subs.get(sessionId);
  if (subs) for (const s of subs) { try { s(event); } catch { /* */ } }
  for (const s of this.allSubs) { try { s(sessionId, event); } catch { /* */ } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/remote/session-bus.test.ts`
Expected: PASS. Existing SessionBus tests should still pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/remote/session-bus.ts src/main/remote/session-bus.test.ts
git commit -m "feat(session-bus): cap ring by bytes in addition to count"
```

---

## Task 7: Process-registry eviction after exit grace

**Files:**
- Modify: `src/main/shell/process-registry.ts:11-25,33,80-95`
- Test: existing `src/main/shell/process-registry.test.ts` (or create)

- [ ] **Step 1: Write failing test**

Append to `src/main/shell/process-registry.test.ts` (the `FakeChild` and `makeRegistry` helpers already exist at the top of that file — reuse them, but extend `makeRegistry` to accept a `now` and `graceMs` option):

```ts
describe('ProcessRegistry exit eviction', () => {
  it('evicts exited processes from this.processes after the grace period', async () => {
    const now = { ms: 0 };
    const events: SessionEvent[] = [];
    const spawned: FakeChild[] = [];
    const factory = (): ShellChild => { const c = new FakeChild(); spawned.push(c); return c; };
    const registry = new ProcessRegistry((e) => events.push(e), factory, { now: () => now.ms, graceMs: 1000 });

    const p = registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
    spawned[0]!.finish(0);
    await spawned[0]!.exited;
    // After exit, entry is still queryable during the grace period.
    expect(registry.get(p.handle)).toBeDefined();
    // Advance past grace and sweep.
    now.ms = 2000;
    registry.sweep();
    expect(registry.get(p.handle)).toBeUndefined();
  });
});
```

You'll need to add a `get(handle): RunningProcess | undefined` method on `ProcessRegistry` if one doesn't already exist (check before adding). Use the same shape as existing accessors.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/shell/process-registry.test.ts`
Expected: FAIL — `sweep`, `now`, `graceMs` not defined.

- [ ] **Step 3: Implement**

Add to `RunningProcess` interface:

```ts
exitedAt: number | null;
```

Extend the existing constructor (which takes `(emit, factory)`) with a third optional opts arg:

```ts
constructor(
  emit: (e: SessionEvent) => void,
  factory: (cmd: string, cwd: string) => ShellChild,
  opts: { now?: () => number; graceMs?: number } = {},
) {
  this.emit = emit;
  this.factory = factory;
  this.now = opts.now ?? Date.now;
  this.graceMs = opts.graceMs ?? 5 * 60_000;
}
private readonly now: () => number;
private readonly graceMs: number;
```

Add a `get(handle)` accessor if one isn't already present:

```ts
get(handle: string): RunningProcess | undefined { return this.processes.get(handle); }
```

In the exit handler (around line 80-95), after `this.children.delete(handle)`:

```ts
const proc = this.processes.get(handle);
if (proc) proc.exitedAt = this.now();
```

Add a `sweep` method and call it lazily at each `spawn` start:

```ts
sweep(): void {
  const cutoff = this.now() - this.graceMs;
  for (const [handle, proc] of this.processes) {
    if (proc.exitedAt !== null && proc.exitedAt < cutoff) {
      this.processes.delete(handle);
    }
  }
}
```

In `spawn`, before allocating a new `RunningProcess`, call `this.sweep();`.

When initializing a new `RunningProcess`, set `exitedAt: null`.

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm vitest run src/main/shell/process-registry.test.ts`
Expected: PASS. Existing registry tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/shell/process-registry.ts src/main/shell/process-registry.test.ts
git commit -m "fix(process-registry): evict exited processes after 5-minute grace"
```

---

## Task 8: Screenshot orphan sweep + reset cleanup

**Files:**
- Create: `src/main/screenshot/cleanup.ts`
- Create: `src/main/screenshot/cleanup.test.ts`
- Modify: `src/main/index.ts` (call sweep at startup; hook resetAllSessions)

- [ ] **Step 1: Write failing tests**

Create `src/main/screenshot/cleanup.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepOrphanScreenshots, wipeAllScreenshots } from './cleanup';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'otto-cleanup-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('deletes session dirs not in the known set', async () => {
  mkdirSync(path.join(root, 's1')); writeFileSync(path.join(root, 's1', 'a.png'), 'x');
  mkdirSync(path.join(root, 's2')); writeFileSync(path.join(root, 's2', 'b.png'), 'x');
  await sweepOrphanScreenshots(root, new Set(['s1']));
  expect(readdirSync(root)).toEqual(['s1']);
});

it('keeps everything when all dirs are known', async () => {
  mkdirSync(path.join(root, 's1')); writeFileSync(path.join(root, 's1', 'a.png'), 'x');
  await sweepOrphanScreenshots(root, new Set(['s1']));
  expect(readdirSync(root)).toEqual(['s1']);
});

it('wipeAllScreenshots removes every session dir', async () => {
  mkdirSync(path.join(root, 's1')); writeFileSync(path.join(root, 's1', 'a.png'), 'x');
  mkdirSync(path.join(root, 's2'));
  await wipeAllScreenshots(root);
  expect(readdirSync(root)).toEqual([]);
});

it('no-op when root does not exist', async () => {
  await sweepOrphanScreenshots(path.join(root, 'nope'), new Set());
  await wipeAllScreenshots(path.join(root, 'nope'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/screenshot/cleanup.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/main/screenshot/cleanup.ts`:

```ts
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export async function sweepOrphanScreenshots(root: string, knownSessionIds: ReadonlySet<string>): Promise<void> {
  let entries: string[];
  try { entries = await fsp.readdir(root); } catch { return; }
  await Promise.all(entries.map(async (name) => {
    if (knownSessionIds.has(name)) return;
    await fsp.rm(path.join(root, name), { recursive: true, force: true });
  }));
}

export async function wipeAllScreenshots(root: string): Promise<void> {
  let entries: string[];
  try { entries = await fsp.readdir(root); } catch { return; }
  await Promise.all(entries.map((name) =>
    fsp.rm(path.join(root, name), { recursive: true, force: true })
  ));
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run src/main/screenshot/cleanup.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Wire in `src/main/index.ts`**

After `registerOttoImageProtocol(...)` is called, schedule the sweep (non-blocking):

```ts
import { sweepOrphanScreenshots, wipeAllScreenshots } from './screenshot/cleanup';
// ...
void (async () => {
  const sessionIds = new Set(await listAllSessionIds()); // existing repo helper; use the real name
  await sweepOrphanScreenshots(path.join(ottoConfigDir, 'screenshots'), sessionIds);
})().catch((err) => logger.warn('orphan screenshot sweep failed', err));
```

Locate the existing `settings.resetAllSessions` IPC handler (search for `resetAllSessions` in `src/main/ipc/`). Inside that handler, after the existing session reset logic, add:

```ts
await wipeAllScreenshots(path.join(ottoConfigDir, 'screenshots'));
```

- [ ] **Step 6: Commit**

```bash
git add src/main/screenshot/cleanup.ts src/main/screenshot/cleanup.test.ts src/main/index.ts
git commit -m "feat(screenshot): startup orphan sweep + wipe on reset-all-sessions"
```

---

## Task 9: Update memory probe to assert the win

**Files:**
- Modify: `src/renderer/state/store.memory-probe.test.ts`

- [ ] **Step 1: Convert Scenario B to use `image-ref` events**

Replace the body of "B: 50 unique screenshot tool-results" with:

```ts
it('B: 50 image-ref screenshot tool-results (no bytes in store)', () => {
  const before = process.memoryUsage();
  const s = useOttoStore.getState();
  s.beginSession('sB');
  s.applyEvent({ type: 'message-start', sessionId: 'sB', messageId: 'mB' });
  for (let i = 0; i < 50; i++) {
    s.applyEvent({
      type: 'tool-call-result',
      sessionId: 'sB',
      messageId: 'mB',
      callId: `c${i}`,
      result: {
        content: [
          { type: 'image-ref', id: `img${i}`, sessionId: 'sB', path: `/tmp/img${i}.png`, width: 1920, height: 1080, mimeType: 'image/png' },
        ],
      },
      isError: false,
    });
  }
  if ((global as { gc?: () => void }).gc) (global as { gc?: () => void }).gc!();
  const after = process.memoryUsage();
  const externalGrowth = after.external - before.external;
  // With refs only, external memory must not balloon. 1 MB is generous slack.
  expect(externalGrowth).toBeLessThan(1 * 1024 * 1024);
});
```

- [ ] **Step 2: Run the probe**

Run: `node --expose-gc ./node_modules/vitest/vitest.mjs run src/renderer/state/store.memory-probe.test.ts --reporter=verbose`
Expected: PASS. Compare console output to the pre-fix baseline (+227 MB external for inline base64) — should now be near zero.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/state/store.memory-probe.test.ts
git commit -m "test(memory-probe): assert ref-based events do not retain bytes"
```

---

## Final verification

- [ ] Run the full test suite: `pnpm test`. All tests pass.
- [ ] Run the typechecker: `pnpm typecheck`. No errors.
- [ ] Run the linter: `pnpm lint`. No errors.
- [ ] Manual: `pnpm dev`, trigger a screenshot via Otto, confirm `<img>` src is `otto-image://...` (DevTools elements panel), and main-process logs show no base64 in event payloads.

---

## Notes for the implementer

- The map in Task 3 (`screenshotRefsByCall`) is module-scoped. If multiple sessions run concurrently this is still correct because callIds are globally unique.
- Task 4's helper `normalizeImageBlocks` is order-positional. If the SDK ever returns extra image blocks beyond what we recorded (it shouldn't), they pass through as legacy `image`. The renderer handles both.
- The protocol handler returns a `Response` with status 404 for invalid requests. The Electron docs note that this is correct for `protocol.handle`.
- If the existing main-process IPC layer doesn't expose a clean `listAllSessionIds()`, use the session repo's existing list method — search `src/main/db` for the pattern.
