# Screenshot Tiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve native screenshot resolution on monitors wider than the Anthropic 2000-px per-edge cap by splitting oversize captures into a row-major grid of tiles, each carrying its virtual-desktop offset so the model can translate tile-local pixels back to virtual coords for clicks.

**Architecture:** A new `tileIfNeeded` in `screenshot/processor.ts` returns 1..N tiles depending on source size, with `(x, y, w, h)` offsets in the source-image coord space. The screenshot tool handler in `sdk-client.ts` rebases tile offsets onto the capture's virtual-desktop origin (now surfaced as `CaptureResult.origin`) and emits one `image` content block per tile plus a `tiles` array in the meta JSON. The system prompt teaches the model the offset-add rule for converting tile-local pixel coords to virtual coords.

**Tech Stack:** TypeScript, Electron `nativeImage` (for the crop path), Vitest. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-05-23-screenshot-tiling-design.md`

---

## File map

**Modified:**
- `src/main/platform/index.ts` — add `origin: { x: number; y: number }` to `CaptureResult`.
- `src/main/platform/linux.ts` — populate `origin` on every `CaptureResult` return (region case, full-desktop case).
- `src/main/screenshot/processor.ts` — add `Tile`, `TileResult`, `tileIfNeeded`. `downscaleIfNeeded` stays.
- `src/main/screenshot/processor.test.ts` — three new tests covering pass-through, 2×1 split metadata, and cap fallback.
- `src/main/agent/sdk-client.ts` — replace `downscaleIfNeeded` in the real `screenshot` MCP handler with `tileIfNeeded`. Emit one image block per tile. Add rebased `tiles` array to the meta. Apply the same to the `OTTO_FAKE_SDK` fake-client `[screenshot]` branch. Add the new bullet + paragraph to `SYSTEM_PROMPT`.

**New:** none.

---

## Task 1: Add `origin` to `CaptureResult`

**Files:**
- Modify: `src/main/platform/index.ts`
- Modify: `src/main/platform/linux.ts`

- [ ] **Step 1: Extend the type**

In `src/main/platform/index.ts`, replace the `CaptureResult` interface (currently lines 28–34) with:

```ts
export interface CaptureResult {
  bytes: Buffer;
  width: number;
  height: number;
  /** All monitors with their virtual-desktop bounds. Coordinates in input tool args are virtual-desktop absolute. */
  monitors: MonitorInfo[];
  /**
   * Top-left of the captured image in virtual-desktop coords.
   * For full-desktop captures this is the virtual-desktop bounds origin (usually 0,0).
   * For region or window captures it is the region's top-left.
   * Consumers add this to image-local pixel offsets to get virtual coords.
   */
  origin: { x: number; y: number };
}
```

- [ ] **Step 2: Populate `origin` in the Linux adapter**

In `src/main/platform/linux.ts`, find the `screenshot.capture` async function. There are two return statements inside it:

1. Full-desktop return (currently around line 149):

   ```ts
   return { bytes: fullBytes, width, height, monitors };
   ```

   Replace with:

   ```ts
   return { bytes: fullBytes, width, height, monitors, origin: { x: bounds.x, y: bounds.y } };
   ```

2. Region/window return (currently around line 164):

   ```ts
   return { bytes: croppedBytes, width, height, monitors };
   ```

   Replace with (where `r` is the in-scope `region` const):

   ```ts
   return { bytes: croppedBytes, width, height, monitors, origin: { x: r.x, y: r.y } };
   ```

- [ ] **Step 3: Typecheck + run existing tests**

Run: `npm run typecheck && npm test -- src/main/screenshot/ src/main/platform/`
Expected: typecheck PASS, tests PASS. (No tests on `CaptureResult.origin` yet — the executor test should still pass since it doesn't assert that field.)

- [ ] **Step 4: Commit**

```bash
git add src/main/platform/index.ts src/main/platform/linux.ts
git commit -m "$(cat <<'EOF'
feat(screenshot): surface capture origin on CaptureResult

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `tileIfNeeded` algorithm

**Files:**
- Modify: `src/main/screenshot/processor.ts`
- Modify: `src/main/screenshot/processor.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/screenshot/processor.test.ts`:

```ts
import { tileIfNeeded } from './processor';
import { vi } from 'vitest';

describe('tileIfNeeded', () => {
  it('returns the input unchanged when both edges are within maxEdge', async () => {
    const bytes = await makePng(1200, 900);
    const r = await tileIfNeeded(bytes, 1920);
    expect(r.fellBackToDownscale).toBe(false);
    expect(r.width).toBe(1200);
    expect(r.height).toBe(900);
    expect(r.tiles).toHaveLength(1);
    expect(r.tiles[0]!.bytes).toBe(bytes);
    expect(r.tiles[0]!.x).toBe(0);
    expect(r.tiles[0]!.y).toBe(0);
    expect(r.tiles[0]!.w).toBe(1200);
    expect(r.tiles[0]!.h).toBe(900);
  });

  it('splits a 2400x800 image into two 1200x800 tiles at maxEdge=1920', async () => {
    const bytes = await makePng(2400, 800);
    // nativeImage.crop is unavailable in vitest's Node runtime; stub the
    // crop pipeline so we can assert metadata.
    vi.doMock('electron', () => ({
      nativeImage: {
        createFromBuffer: () => ({
          crop: ({ x, y, width, height }: { x: number; y: number; width: number; height: number }) => ({
            toPNG: () => Buffer.from(`tile-${x}-${y}-${width}x${height}`),
          }),
          getSize: () => ({ width: 2400, height: 800 }),
        }),
      },
    }));
    // Re-import after mock so the module picks up the stub.
    vi.resetModules();
    const { tileIfNeeded: tileMocked } = await import('./processor');
    const r = await tileMocked(bytes, 1920);
    expect(r.fellBackToDownscale).toBe(false);
    expect(r.tiles).toHaveLength(2);
    expect(r.tiles[0]).toMatchObject({ x: 0,    y: 0, w: 1200, h: 800 });
    expect(r.tiles[1]).toMatchObject({ x: 1200, y: 0, w: 1200, h: 800 });
    expect(r.tiles[0]!.bytes).toEqual(Buffer.from('tile-0-0-1200x800'));
    expect(r.tiles[1]!.bytes).toEqual(Buffer.from('tile-1200-0-1200x800'));
    vi.doUnmock('electron');
    vi.resetModules();
  });

  it('falls back to downscale when the grid would exceed maxTiles', async () => {
    const bytes = await makePng(4000, 4000);
    vi.doMock('electron', () => ({
      nativeImage: {
        createFromBuffer: () => ({
          // The downscale path calls .resize then .toPNG; the tile-grid path
          // calls .crop then .toPNG. We provide both.
          resize: () => ({ toPNG: () => Buffer.from('downscaled-1000x1000') }),
          crop: () => ({ toPNG: () => Buffer.from('unexpected-crop') }),
          getSize: () => ({ width: 4000, height: 4000 }),
        }),
      },
    }));
    vi.resetModules();
    const { tileIfNeeded: tileMocked } = await import('./processor');
    const r = await tileMocked(bytes, 1000, 8); // 4x4 = 16 > 8 → fallback
    expect(r.fellBackToDownscale).toBe(true);
    expect(r.tiles).toHaveLength(1);
    expect(r.tiles[0]!.bytes).toEqual(Buffer.from('downscaled-1000x1000'));
    expect(r.tiles[0]!.w).toBe(1000);
    expect(r.tiles[0]!.h).toBe(1000);
    vi.doUnmock('electron');
    vi.resetModules();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/main/screenshot/processor.test.ts`
Expected: FAIL — `tileIfNeeded` is not exported.

- [ ] **Step 3: Implement `tileIfNeeded`**

Append to `src/main/screenshot/processor.ts`:

```ts
export interface Tile {
  bytes: Buffer;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TileResult {
  tiles: Tile[];
  width: number;
  height: number;
  fellBackToDownscale: boolean;
}

const DEFAULT_MAX_TILES = 8;

export async function tileIfNeeded(
  pngBytes: Buffer,
  maxEdge: number,
  maxTiles: number = DEFAULT_MAX_TILES
): Promise<TileResult> {
  let width: number;
  let height: number;
  const native = readPngDims(pngBytes);
  if (native) {
    width = native.width;
    height = native.height;
  } else {
    const img = nativeImage.createFromBuffer(pngBytes);
    const size = img.getSize();
    width = size.width;
    height = size.height;
  }
  if (!width || !height) {
    throw new Error('could not read PNG dimensions');
  }

  if (Math.max(width, height) <= maxEdge) {
    return {
      tiles: [{ bytes: pngBytes, x: 0, y: 0, w: width, h: height }],
      width,
      height,
      fellBackToDownscale: false,
    };
  }

  const cols = Math.ceil(width / maxEdge);
  const rows = Math.ceil(height / maxEdge);

  if (cols * rows > maxTiles) {
    const ds = await downscaleIfNeeded(pngBytes, maxEdge);
    return {
      tiles: [{ bytes: ds.bytes, x: 0, y: 0, w: ds.width, h: ds.height }],
      width,
      height,
      fellBackToDownscale: true,
    };
  }

  const baseCellW = Math.floor(width / cols);
  const baseCellH = Math.floor(height / rows);
  const img = nativeImage.createFromBuffer(pngBytes);
  const tiles: Tile[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cellX = col * baseCellW;
      const cellY = row * baseCellH;
      // Last column / row absorbs remainder pixels so we cover the full source.
      const cellW = col === cols - 1 ? width - cellX : baseCellW;
      const cellH = row === rows - 1 ? height - cellY : baseCellH;
      const cropped = img.crop({ x: cellX, y: cellY, width: cellW, height: cellH });
      tiles.push({
        bytes: cropped.toPNG(),
        x: cellX,
        y: cellY,
        w: cellW,
        h: cellH,
      });
    }
  }
  return { tiles, width, height, fellBackToDownscale: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/main/screenshot/processor.test.ts`
Expected: PASS all 4 tests (1 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/main/screenshot/processor.ts src/main/screenshot/processor.test.ts
git commit -m "$(cat <<'EOF'
feat(screenshot): tileIfNeeded splits oversize captures into a row-major grid

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire `tileIfNeeded` into the screenshot tool + update system prompt

**Files:**
- Modify: `src/main/agent/sdk-client.ts`

The real screenshot handler is around line 317; the fake-SDK screenshot path is around line 410. Both currently call `downscaleIfNeeded`. The system prompt's screenshot bullet is around line 84, and a new tiling paragraph needs to go near the GUI-workflow section.

- [ ] **Step 1: Replace the `MAX_SCREENSHOT_EDGE` import-side constant block to add a tile cap**

In `src/main/agent/sdk-client.ts`, find the existing block (added in the earlier fix):

```ts
import { downscaleIfNeeded } from '../screenshot/processor';

// Anthropic's many-image request cap is 2000px on either edge. Stay under it
// with margin so a HiDPI capture downscaled exactly to the limit doesn't trip
// the rounding boundary on the server side.
const MAX_SCREENSHOT_EDGE = 1920;
```

Replace with:

```ts
import { downscaleIfNeeded, tileIfNeeded, type Tile } from '../screenshot/processor';

// Anthropic's many-image request cap is 2000px on either edge. Stay under it
// with margin so a HiDPI capture downscaled exactly to the limit doesn't trip
// the rounding boundary on the server side.
const MAX_SCREENSHOT_EDGE = 1920;
// Hard ceiling on tiles per capture: prevents an absurd capture (e.g., 8000px+
// across, 4+ stacked monitors) from blowing up the per-turn image budget.
const MAX_SCREENSHOT_TILES = 8;
```

`downscaleIfNeeded` import stays — it's the cap-overflow fallback path inside `tileIfNeeded`.

- [ ] **Step 2: Replace the REAL screenshot handler body**

In `buildOttoMcpServer`, find the `if (t.name === 'screenshot')` block (around line 317). Replace its body with:

```ts
if (t.name === 'screenshot') {
  const sArgs = args as { region?: { x: number; y: number; w: number; h: number }; window?: string };
  const captured = await withSelfHidden(() => capture(sArgs, getPlatformAdapter()));
  const tiled = await tileIfNeeded(captured.bytes, MAX_SCREENSHOT_EDGE, MAX_SCREENSHOT_TILES);
  const savedPath = await save(captured.bytes, ctx.sessionId, ctx.getConfigDir());
  const meta = {
    path: savedPath,
    width: captured.width,
    height: captured.height,
    monitors: captured.monitors,
    tiles: tiled.tiles.map((t, index) => ({
      index,
      x: captured.origin.x + t.x,
      y: captured.origin.y + t.y,
      w: t.w,
      h: t.h,
    })),
  };
  return {
    content: [
      ...tiled.tiles.map((t) => ({
        type: 'image' as const,
        data: t.bytes.toString('base64'),
        mimeType: 'image/png',
      })),
      { type: 'text' as const, text: JSON.stringify(meta) },
    ],
  };
}
```

- [ ] **Step 3: Replace the FAKE screenshot handler body**

Find the `wantsScreenshot` branch in `createFakeSdkClient` (around line 410). It currently does the same downscale dance for `[screenshot]` test prompts. Inside the `if (outcome === 'allow')` block, replace:

```ts
try {
  const captured = await withSelfHidden(() => capture({}, getPlatformAdapter()));
  const downscaled = await downscaleIfNeeded(captured.bytes, MAX_SCREENSHOT_EDGE);
  const savedPath = await save(
    captured.bytes,
    sid,
    deps?.getConfigDir?.() ?? `${process.env.XDG_CONFIG_HOME ?? '/tmp'}/otto`
  );
  const meta = {
    path: savedPath,
    width: captured.width,
    height: captured.height,
    monitors: captured.monitors,
  };
  void downscaled;
  yield { type: 'tool-call-start', callId: 'c-ss', name: 'screenshot', input: {} };
  yield { type: 'tool-call-result', callId: 'c-ss', result: meta, isError: false };
} catch (err) {
  ...
}
```

with:

```ts
try {
  const captured = await withSelfHidden(() => capture({}, getPlatformAdapter()));
  const tiled = await tileIfNeeded(captured.bytes, MAX_SCREENSHOT_EDGE, MAX_SCREENSHOT_TILES);
  const savedPath = await save(
    captured.bytes,
    sid,
    deps?.getConfigDir?.() ?? `${process.env.XDG_CONFIG_HOME ?? '/tmp'}/otto`
  );
  const meta = {
    path: savedPath,
    width: captured.width,
    height: captured.height,
    monitors: captured.monitors,
    tiles: tiled.tiles.map((t, index) => ({
      index,
      x: captured.origin.x + t.x,
      y: captured.origin.y + t.y,
      w: t.w,
      h: t.h,
    })),
  };
  yield { type: 'tool-call-start', callId: 'c-ss', name: 'screenshot', input: {} };
  yield { type: 'tool-call-result', callId: 'c-ss', result: meta, isError: false };
} catch (err) {
  ...
}
```

(Keep the `catch` block as-is.)

- [ ] **Step 4: Update `SYSTEM_PROMPT` — screenshot bullet**

In `src/main/agent/sdk-client.ts`, find the screenshot bullet in `SYSTEM_PROMPT` (currently begins `'- screenshot(region?, window?): capture the virtual desktop as a PNG.`). Replace that single line with:

```ts
'- screenshot(region?, window?): capture the virtual desktop as a PNG. Default is the full desktop (all monitors stitched); `region` crops by virtual-desktop coords; `window` (name pattern like "Firefox") crops to that window\'s bounds via kdotool — strongly preferred for iteration once a target window is identified, since it\'s much smaller and faster than a full capture. Result includes a `monitors` array with each display\'s {x, y, w, h} and a `tiles` array describing how the image was split.',
```

- [ ] **Step 5: Update `SYSTEM_PROMPT` — add tiling paragraph**

In the same `SYSTEM_PROMPT` array, find the blank `''` separator line right before `'GUI workflow — when the user asks you to type, click, …'`. Insert two new array elements (the paragraph + a blank separator) right before that GUI workflow line:

```ts
'When a screenshot is too large for a single image, it is split into TILES. The meta\'s `tiles` array lists each tile\'s virtual-desktop rect: `[{ index, x, y, w, h }, ...]`, in the same order the image attachments appear. To convert a pixel you see at `(ix, iy)` inside tile N to virtual-desktop coords for clicking: `(tiles[N].x + ix, tiles[N].y + iy)`. The image pixel pitch is always 1:1 with virtual-desktop pixels (no DPR scaling) so no further math is needed. When `tiles.length === 1`, the offset is `(0, 0)` for full-desktop captures and the region/window origin for crops — translation still works the same way.',
'',
```

(The empty string maintains the existing blank-line rhythm between paragraphs in the array.)

- [ ] **Step 6: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: PASS — typecheck flags any wiring mistakes; existing tests stay green (no test asserts on the old single-image meta shape).

If `Tile` import isn't actually needed anywhere besides the function call (it's only used for type-narrowing in the closure), TypeScript may emit `'Tile' is declared but never used`. If lint flags it, remove `Tile` from the import — the implementation only needs the function.

- [ ] **Step 7: Manual smoke test on the 3440×1440 setup**

Run: `npm run dev`

1. Ask Otto to take a full-desktop screenshot.
2. Inspect the tool result in the chat: confirm two image attachments and a meta JSON containing `tiles: [{index:0, x:0, y:0, w:1720, h:1440}, {index:1, x:1720, y:0, w:1720, h:1440}]` (numbers may vary slightly depending on actual virtual-desktop bounds).
3. Ask Otto to "click somewhere on the right half of the desktop." The resulting `click(x, y)` should land with `x ∈ [1720, 3440]` — i.e., tile-1 local pixels correctly offset.
4. Ask Otto to `screenshot({ window: "Firefox" })`. Expect a single tile with `tiles[0].x/y` matching Firefox's window bounds (NOT `(0,0)`).

If step 3 lands on the wrong half, the most likely cause is the meta's `tiles[N].x` not getting the `captured.origin.x` rebase. Re-check Step 2's `captured.origin.x + t.x` arithmetic.

If `ToolCallCard` (the renderer) renders multi-image content awkwardly, note it but don't fix in this task — the agent-side behavior is what gates this work. Follow-up if needed.

- [ ] **Step 8: Commit**

```bash
git add src/main/agent/sdk-client.ts
git commit -m "$(cat <<'EOF'
feat(screenshot): tile oversize captures and ship per-tile virtual offsets

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes (already applied above)

- **Spec coverage:**
  - Spec §1 (tile algorithm) → Task 2.
  - Spec §2 (tool result shape + region/window offsets) → Task 3 Steps 2–3 (handler) plus Task 1 (the `captured.origin` field the handler reads).
  - Spec §3 (system prompt) → Task 3 Steps 4–5.
  - Spec §4 (testing) → Task 2 Step 1 (three new tests).
  - Spec §5 (manual smoke) → Task 3 Step 7.
- **Placeholder scan:** every code block is complete; the prompt-update lines are quoted verbatim.
- **Type consistency:** `Tile { bytes, x, y, w, h }` and `TileResult { tiles, width, height, fellBackToDownscale }` shapes match between Task 2's definition and Task 3's consumer. `CaptureResult.origin: { x, y }` shape matches between Task 1's declaration and Task 3's `captured.origin.x` read. `MAX_SCREENSHOT_EDGE` (existing) and `MAX_SCREENSHOT_TILES` (new) are both passed to `tileIfNeeded` in both call sites (real + fake) in Task 3.
