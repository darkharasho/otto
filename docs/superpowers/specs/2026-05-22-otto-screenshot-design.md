# Otto Screenshot — Design

**Date:** 2026-05-22
**Sub-project:** 4 of 6 (Screenshot — the first half of the original "computer-use" sub-project)
**Status:** Spec, awaiting user review

## Context

Sub-projects 1–3 are live: skeleton, autonomy framework, shell adapter. Otto can chat, gate tool calls by action class, and execute shell commands with live process streaming. The next jump in capability is letting the agent **see** what's on the user's screen.

The original decomposition called sub-project 4 "computer-use (screenshot + mouse/keyboard)." Wayland input injection (mouse/keyboard) on KDE Plasma 6 is involved — RemoteDesktop portal or `ydotool`/uinput — and we already had a bumpy time with the GlobalShortcuts portal on this Bazzite install. Splitting the work in half:

- **Sub-project 4 (this spec):** Screenshot only.
- **Sub-project 4b (future):** Input injection.

Screenshot is comparatively easy on KDE: `spectacle -bn` works natively via KWin with no portal prompts. Shipping screenshot first unlocks the model's vision — it can read what's on screen, describe a window, find a button, identify a problem — even before it can act.

## Goals

- **One tool:** `screenshot({ region? })`. Captures the active monitor (where the cursor is). Optional `region: { x, y, w, h }` in monitor-relative pixels.
- **Returns** `{ path, width, height, monitor }` metadata to the agent. The captured PNG is *also* attached to the tool result as an `image` content block so multimodal Claude can see it.
- **Action class `read`.** Always allow. The captured image renders inline in the chat — there's no covert capture.
- **Persistence.** Native-resolution PNG written to `<XDG_CONFIG_HOME>/otto/screenshots/<sessionId>/<uuid>.png`. The disk copy survives across app restarts.
- **Auto-downscale for the model.** Before base64-encoding for the SDK, if the longest edge exceeds 4096 px, downscale the in-memory copy with bilinear. Disk copy stays at native res.
- **Inline render.** The renderer's existing `ToolCallCard` is extended: when the tool name is `screenshot`, it renders the captured image via `<img src="file://...">` inside the expanded card.
- **Active-monitor selection.** Uses Electron's `screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`.
- **KDE Wayland capture backend.** `spectacle -bn` (no UI, no notification). Wrapped behind `PlatformAdapter.screenshot` so future macOS/Windows/non-KDE backends plug in cleanly.

## Non-Goals

- **Input injection** (mouse/keyboard) — sub-project 4b.
- Window-specific capture, monitor-selection arg, full-virtual-desktop capture (will revisit when the agent needs to look at a non-active monitor).
- Non-KDE Linux backends (grim, gnome-screenshot, portal Screenshot interface).
- macOS / Windows backends.
- Image annotation, OCR, in-app cropping UI.
- Streaming or continuous capture / observation loops (sub-project 6).
- Click-to-zoom / open-in-default-viewer affordance (v1 just renders inline).
- Automatic GC of accumulated screenshot files (future polish).
- A `screenshot` ContentBlock kind separate from `tool_result` — we reuse the existing `tool_use`/`tool_result` pair.

## Architecture

A new `src/main/screenshot/` module with three thin units, plus a small extension to `PlatformAdapter` and a special case in the SDK handler.

- **`screenshot/executor.ts`** — `capture(opts, adapter)` calls `adapter.screenshot.capture(opts)` and returns its result unchanged. Trivial seam for testing.
- **`screenshot/processor.ts`** — `downscaleIfNeeded(pngBytes, maxEdge)`. Reads PNG header for current dimensions; if longest edge ≤ `maxEdge`, returns unchanged. Otherwise resizes via `sharp` (primary) or Electron's `nativeImage` (fallback).
- **`screenshot/store.ts`** — `save(bytes, sessionId, configDir)` writes `<configDir>/screenshots/<sessionId>/<uuid>.png` and returns the absolute path. Creates per-session directory on first write.
- **`PlatformAdapter.screenshot.capture(opts)`** — the per-OS capture seam. `LinuxAdapter` invokes `spectacle` and returns `{ bytes, width, height, monitor }`. Future macOS uses `screencapture`; Windows uses BitBlt or PrintScreen; non-KDE Linux uses grim/portal.
- **`buildScreenshotTool(deps)`** in `src/main/agent/tools.ts` — produces a static-`read`-class `OttoTool` named `'screenshot'`. Its `run` throws — the SDK handler intercepts so it can attach the image to the result.
- **SDK handler integration.** `sdk-client.ts` gains a special case alongside `shell_spawn`: when `t.name === 'screenshot'`, run the capture pipeline (executor → processor → store), return `[{ image: base64(downscaled) }, { text: JSON({path, width, height, monitor}) }]`.
- **Renderer.** `ToolCallCard` detects `name === 'screenshot'` and `result.path`, renders an `<img>` inside the expanded card.

### Why no new ContentBlock or SessionEvent

The screenshot result fits naturally into the existing `tool_use` / `tool_result` content blocks. The renderer reads the result, detects the screenshot shape, and renders accordingly. This avoids expanding `ContentBlock`, the store reducer, IPC event types, or the SDK handler beyond the bare minimum.

### Directory Layout

```
src/main/screenshot/
  executor.ts                      # call adapter.screenshot.capture
  executor.test.ts
  processor.ts                     # downscaleIfNeeded
  processor.test.ts
  store.ts                         # write file to disk
  store.test.ts
src/main/platform/index.ts         # +PlatformAdapter.screenshot interface
src/main/platform/linux.ts         # spectacle impl
src/main/agent/tools.ts            # +buildScreenshotTool
src/main/agent/sdk-client.ts       # special-case screenshot result
src/main/agent/tools.test.ts       # +screenshot tool tests
src/renderer/components/ToolCallCard.tsx   # render inline <img> for screenshot
src/renderer/components/ToolCallCard.test.tsx  # +screenshot render tests
tests/integration/screenshot.spec.ts        # fake-SDK driven smoke
```

## Components

### `PlatformAdapter.screenshot.capture`

```ts
interface MonitorInfo {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

interface CaptureResult {
  bytes: Buffer;
  width: number;
  height: number;
  monitor: MonitorInfo;
}

interface PlatformAdapter {
  // ... existing fields ...
  screenshot: {
    capture(opts: { region?: { x: number; y: number; w: number; h: number } }): Promise<CaptureResult>;
  };
}
```

`LinuxAdapter.screenshot.capture` implementation:

1. Resolve active monitor via `screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`. Translate Electron's `Display` to `MonitorInfo`.
2. If `opts.region` is set, validate `{ x ≥ 0, y ≥ 0, x + w ≤ monitor.w, y + h ≤ monitor.h }`. Reject otherwise.
3. Build `spectacle` args. Two cases:
   - **Full monitor:** `spectacle -bnf -o <tmp>` (`-f` = current screen; the implementer verifies this against `spectacle --help` at runtime — flag spelling has drifted across versions, so the plan documents a small probe).
   - **Region:** `spectacle -bn --region <absX,absY,w,h> -o <tmp>` where `absX = monitor.x + region.x`, `absY = monitor.y + region.y`. Account for `monitor.scale` if spectacle uses physical pixels (verified at runtime).
4. Spawn via `child_process.spawn` with a 5 s timeout. SIGTERM → SIGKILL 1 s later.
5. Read the file, decode PNG header for actual dimensions, return `CaptureResult`.

The temp file lives in `os.tmpdir()` with a UUID name; deleted after read regardless of outcome.

### `executor.ts`

```ts
export async function capture(
  opts: { region?: { x: number; y: number; w: number; h: number } },
  adapter: PlatformAdapter
): Promise<CaptureResult> {
  return adapter.screenshot.capture(opts);
}
```

### `processor.ts`

```ts
export async function downscaleIfNeeded(
  pngBytes: Buffer,
  maxEdge: number
): Promise<{ bytes: Buffer; width: number; height: number; downscaled: boolean }>;
```

- Reads PNG IHDR for dimensions (no full decode).
- If `max(width, height) <= maxEdge`, returns `{ bytes: pngBytes, width, height, downscaled: false }`.
- Otherwise computes the target dimensions (longest edge → `maxEdge`, aspect preserved, integer rounding), resizes via `sharp(pngBytes).resize(targetW, targetH).png().toBuffer()`.

**`sharp` install caveat:** `sharp` ships native prebuilds for common platforms and "just works" with electron-vite. If install fails on the user's environment, swap to Electron's `nativeImage`:

```ts
const img = nativeImage.createFromBuffer(pngBytes);
const { width, height } = img.getSize();
const resized = img.resize({ width: targetW, height: targetH });
return { bytes: resized.toPNG(), width: targetW, height: targetH, downscaled: true };
```

The plan tells the implementer to try `sharp` first and fall back to `nativeImage` if it doesn't install cleanly.

### `store.ts`

```ts
export async function save(
  bytes: Buffer,
  sessionId: string,
  configDir: string
): Promise<string>;
```

- Computes `dir = <configDir>/screenshots/<sessionId>/`.
- `fs.mkdir(dir, { recursive: true })`.
- Writes `<dir>/<randomUUID>.png` and returns the absolute path.

### `buildScreenshotTool`

```ts
export function buildScreenshotTool(): OttoTool {
  return {
    name: 'screenshot',
    description: 'Capture the active monitor (or an optional region of it) as a PNG. Returns { path, width, height, monitor }. The captured image is attached so the model can see it.',
    actionClass: 'read',
    schema: z.object({
      region: z.object({
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        w: z.number().int().positive(),
        h: z.number().int().positive(),
      }).optional(),
    }),
    async run(_input) {
      throw new Error('screenshot must be invoked via the SDK handler');
    },
  };
}
```

The tool is registered alongside `stubTools` and `buildShellTools(...)` in the SDK handler's per-turn build:

```ts
const allTools: OttoTool[] = [...stubTools, ...buildShellTools(deps.getRegistry), buildScreenshotTool()];
```

### SDK handler special case

`sdk-client.ts`'s wrapped tool handler currently special-cases `shell_spawn`. Add a parallel case for `screenshot`:

```ts
if (t.name === 'screenshot') {
  const sArgs = args as { region?: { x: number; y: number; w: number; h: number } };
  const captured = await capture(sArgs, getPlatformAdapter());
  const downscaled = await downscaleIfNeeded(captured.bytes, 4096);
  const path = await save(captured.bytes, ctx.sessionId, deps.getConfigDir());
  const meta = {
    path,
    width: captured.width,
    height: captured.height,
    monitor: captured.monitor,
  };
  return {
    content: [
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: downscaled.bytes.toString('base64') } },
      { type: 'text' as const, text: JSON.stringify(meta) },
    ],
  };
}
```

`RealSdkClientDeps` gains a new field:

```ts
getConfigDir: () => string;
```

Wired in `src/main/index.ts`: `getConfigDir: () => ottoConfigDir`.

### Renderer — `ToolCallCard`

`ToolCallCard` currently renders the `result` object as JSON inside the expanded card. Add a branch:

```tsx
const isScreenshot = name === 'screenshot' && hasScreenshotShape(result);

// Inside the expanded body, before the JSON dump:
{isScreenshot && (
  <img
    src={`file://${(result as { path: string }).path}`}
    alt="screenshot"
    className="my-2 max-w-full rounded border border-border"
  />
)}
```

`hasScreenshotShape(result)` checks `typeof result === 'object' && result && 'path' in result`. The JSON dump stays so the model's actual returned metadata is still inspectable.

No new IPC channels or session events. The path is read via Electron's `file://` URL scheme, which the renderer's `BrowserWindow` allows for local files in dev (vite serves `http://localhost:5173`; `<img src="file://...">` works alongside it in Electron because the renderer's web preferences enable local resource access via the preload-loaded path). If `file://` paths get blocked by sandboxing, swap to a custom `otto://` protocol registered in main — flagged in the plan as a fallback if it bites.

## Data Flow

1. Model calls `screenshot({ region? })`.
2. SDK handler sees `t.name === 'screenshot'`. Action class is static `'read'`. Broker decides `'allow'` (read class is always allowed).
3. `capture(args, adapter)` invokes `LinuxAdapter.screenshot.capture(args)`:
   - Resolve active monitor via `screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`.
   - Validate region against monitor bounds.
   - Spawn `spectacle -bnf -o <tmp>` (or `--region` variant). 5 s timeout.
   - Read PNG, return `{ bytes, width, height, monitor }`.
4. `downscaleIfNeeded(bytes, 4096)` produces the model-bound copy.
5. `save(bytes, sessionId, configDir)` writes native-resolution PNG to disk, returns path.
6. Handler returns `[image: base64(downscaled), text: JSON({ path, width, height, monitor })]`.
7. The SDK's `tool_use` + `tool_result` events flow to the renderer normally.
8. `ToolCallCard` for `screenshot` detects the result shape, renders `<img src="file://path">` inside the expanded card.

No new SessionEvents. No store reducer changes. No new IPC channels.

## Error Handling

| Case | Behavior |
|------|----------|
| `spectacle` not installed | Tool returns `{ isError: true, content: "spectacle not found — install kde-spectacle" }`. Detected by `which spectacle` on first capture; result cached per process. |
| `spectacle` non-zero / no file produced | Tool returns `{ isError: true, content: "screenshot failed: <stderr>" }`. |
| Region out of monitor bounds | Tool returns `{ isError: true, content: "region {x,y,w,h} exceeds monitor bounds {0,0,W,H}" }`. Validated before spectacle is invoked. |
| Region has zero or negative dimensions | Caught by zod (`positive()`). Returns zod's standard validation error. |
| Disk write fails (no space, permissions) | Tool returns `{ isError: true, content: "failed to save screenshot: <errno>" }`. Native bytes discarded; the model sees the error string with no image. |
| `sharp` / `nativeImage` downscale throws | Log warn, send the **native** bytes as the image content instead. If they exceed Claude's input cap, the API rejection surfaces normally through SessionManager. |
| Capture timeout | 5 s budget. SIGTERM → SIGKILL after 1 s. Returns `{ isError: true, content: "screenshot timed out" }`. |
| Concurrent screenshot calls in one turn | Each runs independently; each writes its own UUID file. No locking. |
| Per-session screenshots directory doesn't exist | `store.save` creates it with `mkdir -p`. |
| Renderer can't load `file://` path | If observed at runtime, register a custom `otto://` protocol in main and rewrite the `<img src>` to `otto://screenshot/<sessionId>/<uuid>.png`. Documented in the plan as a fallback only; v1 ships `file://`. |
| Screenshots accumulate on disk forever | Documented limitation. v1 ships no GC. A future polish pass can prune by age or session expiry. |

**Logging:** capture logs `screenshot captured monitor=<id> dims=<wxh> saved=<path>` at info; downscale operations at debug; errors at warn/error.

## Testing

### Unit (Vitest)

- **`executor.test.ts`**: forwards to `adapter.screenshot.capture(opts)`; rejection propagates.
- **`processor.test.ts`**: under-threshold image unchanged (`downscaled: false`); over-threshold resized with longest edge equal to `maxEdge` and aspect preserved within 1 px tolerance. Fixtures generated via `sharp` (or `nativeImage` if using the fallback) at known dimensions; no real capture in unit tests.
- **`store.test.ts`**: creates the per-session directory, writes a UUID file, returns the path; two saves write distinct files; written bytes equal input bytes.
- **`tools.test.ts` additions**: `screenshot` tool has `actionClass: 'read'`, no `actionClassFor`, no `denyPatterns`; schema rejects negative `region.x`, missing `region.w`, etc.; direct `.run(...)` throws.

### Component (Vitest + RTL)

- **`ToolCallCard.test.tsx` additions**:
  - When `name === 'screenshot'` and `result = { path, width, height, monitor }`, the expanded card renders an `<img>` whose `src` starts with `file://` and includes the path; original JSON view is still present.
  - When `name === 'screenshot'` but `result` lacks `path`, no `<img>` is rendered.
  - Non-screenshot tools render unchanged.

### Integration (Playwright)

Add `[screenshot]` keyword branch to `createFakeSdkClient`. When the prompt contains `[screenshot]` and `deps.broker` is set:

- Fake client calls `broker.decide` for `toolName: 'screenshot'`, `actionClass: 'read'` (always allows).
- Invokes the **real** capture pipeline (executor + processor + store) using `getPlatformAdapter()` and a configDir derived from `XDG_CONFIG_HOME`.
- Emits `tool-call-start` + `tool-call-result` with the metadata so the renderer reducer pushes a normal `tool_use`/`tool_result` pair.

`tests/integration/screenshot.spec.ts`:

1. Pre-write `settings.json` (balanced mode) into the test's `XDG_CONFIG_HOME`.
2. Launch Electron with `OTTO_FAKE_SDK=1`.
3. Submit `[screenshot] please`.
4. Assert a `ToolCallCard` named `screenshot` appears within 10 s.
5. Expand the card; assert an `<img>` is visible with a `src` matching `file://` + the configDir prefix.
6. Assert the PNG file exists at the reported path.

**CI guard:** the test skips with `test.skip(!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY, 'no display')` so headless CI doesn't fail at the spectacle invocation. Locally (with a display) the test runs end-to-end through real `spectacle`.

### Manual Verification

- [ ] In balanced mode, prompt "take a screenshot" — runs without prompting. `ToolCallCard` expands to show the inline image.
- [ ] Region capture: "take a screenshot of region 100,100 500x300" — renders the cropped image.
- [ ] Region out of bounds (e.g., `w: 99999`) — clear error card; no file written.
- [ ] Multi-monitor: move cursor to the secondary display, ask for a screenshot — captures the secondary display.
- [ ] `~/.config/otto/screenshots/<sessionId>/` contains the PNG files at native resolution.
- [ ] In strict mode, screenshot still runs (read class is always allowed).

## Open Questions

None blocking. Known future-deferred items:

- Multi-monitor selection (a `display?: number` arg) — sub-project 4 ships active-monitor only.
- Window-specific capture via portal-driven window picker.
- Non-KDE Linux backends (grim, gnome-screenshot, portal Screenshot interface).
- macOS / Windows backends.
- Click-to-zoom / open-in-default-viewer.
- Screenshot file GC.
- `otto://` custom protocol if `file://` paths become problematic.
