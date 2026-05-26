# Screenshot ImageRef Architecture

**Date:** 2026-05-26
**Status:** Design — pending implementation plan

## Problem

Otto was observed using ~20GB RAM during active turns. Investigation (`memory/project_ram_usage.md`) and a vitest memory probe (`src/renderer/state/store.memory-probe.test.ts`) verified:

- **Renderer Zustand store retains screenshot base64 forever.** 50 unique 4MB screenshots add **+227 MB RSS** (+219 MB external) to the renderer; `store.reset()` does not promptly release V8 pages.
- **SessionBus ring** (`src/main/remote/session-bus.ts:62`) caps by event count (200), not bytes. Image-heavy events can fill it with hundreds of MB.
- **Process-registry leak** (`src/main/shell/process-registry.ts:33-34,94`): `RunningProcess` entries are never deleted from `this.processes` after exit; each holds up to 4 MB of stdout/stderr.
- **Claude Agent SDK conversation history is NOT in Otto's main-process RAM** across turns. Each `sdk.query()` spawns a fresh `cli.js` subprocess that loads the conversation from disk via `--resume <id>`. Its RSS spike is real but transient and lives in a separate process. The 20 GB observation was likely process-tree aggregate including these subprocesses plus accumulated Otto-side retention.

Today screenshots already save to disk at `sdk-client.ts:337` via `screenshot/store.ts#save`. The base64 bytes circulating through Otto's processes are **duplicates** of an already-persisted file.

## Goals

1. Single source of truth for screenshot bytes: the on-disk PNG at `<configDir>/screenshots/<sessionId>/<id>.png`.
2. Long-running sessions must not grow Otto's renderer or main-process RSS with screenshot data.
3. Backwards-compatible with existing saved sessions that contain inlined base64.
4. No regression in agent behavior — bytes still reach the Anthropic API at tool-call time exactly as today.

## Non-goals

- Trimming the Claude Agent SDK's on-disk session state to reduce the per-turn subprocess RSS spike. Deferred as a known limitation.
- Serving images to the renderer-remote (phone bridge) over WS. Tracked as a follow-up.

## Architecture

### Single source of truth + `ImageRef`

The on-disk PNG is canonical. A new content-block shape carries a reference, never bytes:

```ts
type ImageRef = {
  type: 'image-ref';
  id: string;            // randomUUID; matches filename stem
  sessionId: string;
  path: string;          // absolute path under <configDir>/screenshots/<sessionId>/
  width: number;
  height: number;
  mimeType: 'image/png';
};
```

Bytes only materialize in two places:

1. **At the MCP tool-result construction** in `sdk-client.ts:333-361` — required by the Anthropic API for the current turn. Bytes are read from the disk file via `fs.readFile` and base64-encoded inline; the in-memory `Buffer` goes out of scope as soon as the tool result is yielded to the SDK.
2. **At the renderer image element** — Chromium fetches bytes via a custom `otto-image://` protocol when an `<img>` is rendered. Chromium's existing image cache manages eviction; Otto does not hold these bytes in JS.

Every other layer (SessionBus events, IPC payloads, Zustand store, persisted session messages) carries `ImageRef` only.

### Event / IPC normalization

When the SDK emits a tool result containing image content, the path between SDK output and event publication (in `src/main/agent/session.ts`, where SDK events become `SessionEvent`s) normalizes image content blocks:

- The screenshot tool implementation in `sdk-client.ts:333-361` keeps a small per-session `Map<callId, { refs: ImageRef[] }>` recording the ref(s) produced for each tool call (one ref per tile, plus the meta block).
- When `session.ts` translates an SDK `tool_result` user message into a `SessionEvent`, it looks up the callId in that map. If found, each `{ type: 'image', ... }` block in positional order is replaced with the corresponding `ImageRef`; non-image blocks pass through. The map entry is deleted after substitution.
- If the lookup misses (e.g. non-screenshot tool returning an image, or a result observed before the tool ran in our process — neither happens today), the block passes through unchanged as legacy inline `image`. Renderer handles both.

Result: SessionEvents flowing to the renderer (via IPC) and to the SessionBus ring carry ~200 B per screenshot ref instead of ~4 MB of base64.

### `SessionEvent` contract changes

`src/shared/ipc-contract.ts` and `src/shared/messages.ts` add the `ImageRef` content-block shape alongside the existing inline `image`. The renderer's content-block discriminated union handles both. New sessions only ever produce refs; old saved sessions with inline images continue to render via the existing path.

### Renderer protocol + display

Register a custom Electron protocol once at app ready, in `src/main/index.ts`:

```ts
import { app, protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

protocol.registerSchemesAsPrivileged([
  { scheme: 'otto-image', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false } },
]);

app.whenReady().then(() => {
  protocol.handle('otto-image', (req) => {
    // URL shape: otto-image://<sessionId>/<imageId>.png
    const url = new URL(req.url);
    const sessionId = url.hostname;
    const file = url.pathname.replace(/^\//, '');
    const SAFE = /^[A-Za-z0-9_-]+$/;
    if (!SAFE.test(sessionId)) return new Response(null, { status: 404 });
    if (!/^[A-Za-z0-9_-]+\.png$/.test(file)) return new Response(null, { status: 404 });
    const root = path.join(getConfigDir(), 'screenshots');
    const abs = path.join(root, sessionId, file);
    if (!existsSync(abs)) return new Response(null, { status: 404 });
    // Block symlink traversal outside the root.
    const real = realpathSync(abs);
    if (!real.startsWith(root + path.sep)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(real).toString());
  });
});
```

Components that render image blocks (`src/renderer/components/ToolCallCard.tsx` and any siblings) emit:

```tsx
<img src={`otto-image://${ref.sessionId}/${ref.id}.png`} width={ref.width} height={ref.height} loading="lazy" />
```

`loading="lazy"` defers off-screen image decoding. Chromium evicts under its own memory pressure; Otto holds no JS reference to the bytes.

Renderer-remote (`src/renderer-remote/screenshot.tsx`) is out of scope for this change. Tracked as follow-up.

### Process-registry cleanup

`src/main/shell/process-registry.ts`:

- Add `exitedAt: number | null` to `RunningProcess`; set it in the exit handler.
- A sweep (timer every 60s, or run lazily at each `spawn`) deletes entries with `exitedAt !== null && Date.now() - exitedAt > 5 * 60_000`.
- The renderer's `process_output` content block already carries the lines it needs to display; it doesn't read from the main-process buffer after exit.

### SessionBus byte-cap

With image refs in events, individual events shrink dramatically and the 200-count cap is rarely the binding constraint. Add a defensive per-session byte cap anyway:

- Track `currentBytes: Map<string, number>` per session.
- Estimate event size via `JSON.stringify(entry).length`.
- After each publish, drop oldest until `currentBytes[sessionId] <= MAX_RING_BYTES` (8 MB default).

### On-disk screenshot lifecycle

- **Session delete** (existing IPC handler): `fs.rm('<configDir>/screenshots/<sessionId>/', { recursive: true, force: true })`. Today these files are orphaned; this change makes deletion correct.
- **Startup orphan sweep**: at app startup, list `<configDir>/screenshots/<dir>` and delete any whose `<dir>` is not a known session id in the SQLite session table. Async, non-blocking.
- **No TTL** on active-session screenshots — they are part of the session.

## Migration

- `ImageRef` is additive. The renderer's content-block union accepts both `image` (legacy inline) and `image-ref` (new). Old saved sessions render as today.
- New sessions write only `image-ref`. Disk format for saved messages: forward-compatible (JSON column carries the new shape).
- No feature flag; this is a pure win and adds no user-facing behavior change.

## Verification

Update the existing memory probe (`src/renderer/state/store.memory-probe.test.ts`) to drive ref-based `tool-call-result` events and assert that 50 screenshot results add **< 1 MB** of heap (vs. the verified +227 MB on inline base64).

New tests:

- `otto-image` protocol handler: path-traversal attempts (`..`, absolute paths, leading slashes, symlinks pointing outside root) must 404; valid request serves the PNG bytes.
- Process-registry eviction after the 5-minute grace.
- SessionBus byte-cap drops oldest events when over the limit.
- Event normalization: a screenshot tool result is rewritten to `image-ref` before publication; non-image content passes through.
- Session-delete IPC removes the on-disk screenshot directory.

## Files touched (summary)

**Modified:**
- `src/shared/ipc-contract.ts`, `src/shared/messages.ts` — add `ImageRef`
- `src/main/agent/sdk-client.ts:333-361` — read bytes from disk, drop in-memory `Buffer` after yield
- `src/main/agent/session.ts` — normalize image blocks to refs before publishing
- `src/main/index.ts` — register `otto-image` protocol; wire orphan sweep at startup; wire session-delete dir removal
- `src/main/remote/session-bus.ts` — add byte cap
- `src/main/shell/process-registry.ts` — add exit eviction
- `src/renderer/state/store.ts` — no change needed if `ImageRef` is just another content-block variant; UI components handle the rendering difference
- `src/renderer/components/ToolCallCard.tsx` (and siblings rendering image blocks) — use `otto-image://` URL
- `src/renderer/state/store.memory-probe.test.ts` — assertions updated to expect ref-based events

**New tests** as listed in Verification.

**Out of scope / follow-ups:**
- Renderer-remote image serving (phone bridge).
- Trimming SDK on-disk session state to reduce per-turn subprocess RSS.
