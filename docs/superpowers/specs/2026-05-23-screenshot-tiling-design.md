# Screenshot Tiling — Design

**Date:** 2026-05-23
**Status:** Draft for implementation

## Goal

Preserve native screenshot resolution on monitors wider than the Anthropic many-image per-edge limit (2000px). When a capture exceeds the cap, split it into a row-major grid of tiles that each fit, and ship per-tile virtual-desktop offsets so the model can translate tile-local pixel coords back to virtual coords for clicking.

## Non-goals

- Always-tile behavior. Captures smaller than the cap pass through as a single tile (zero behavior change for the common window/region case).
- DPR/scale handling. Tiles preserve native pixels; image pitch stays 1:1 with virtual-desktop pixels.
- Renderer UI changes to `ToolCallCard`. If multi-image results display poorly there, follow-up; agent-side functionality is the focus.
- Replacing or hardening `downscaleIfNeeded` itself — it's reused as the cap-overflow fallback.

## Section 1 — Tile algorithm

New function in `src/main/screenshot/processor.ts`:

```ts
export interface Tile {
  bytes: Buffer;
  x: number;          // top-left in the SOURCE image's coord space (caller adds capture origin)
  y: number;
  w: number;
  h: number;
}

export interface TileResult {
  tiles: Tile[];
  width: number;      // source width
  height: number;     // source height
  fellBackToDownscale: boolean;
}

export async function tileIfNeeded(
  pngBytes: Buffer,
  maxEdge: number,
  maxTiles?: number   // default 8
): Promise<TileResult>;
```

Algorithm:

1. Read dims via the existing `readPngDims` helper (or `nativeImage.getSize()` as fallback).
2. If `max(width, height) ≤ maxEdge` → return `{ tiles: [{ bytes: pngBytes, x: 0, y: 0, w: width, h: height }], width, height, fellBackToDownscale: false }`. The input buffer is returned unchanged (no re-encode).
3. Compute `cols = Math.ceil(width / maxEdge)`, `rows = Math.ceil(height / maxEdge)`.
4. If `cols * rows > maxTiles` (default 8):
   - Call `downscaleIfNeeded(pngBytes, maxEdge)`.
   - Return `{ tiles: [{ bytes: downscaled.bytes, x: 0, y: 0, w: downscaled.width, h: downscaled.height }], width, height, fellBackToDownscale: true }`.
5. Otherwise, produce a row-major grid (top-to-bottom, left-to-right):
   - Each tile cell defaults to `Math.floor(width / cols) × Math.floor(height / rows)`.
   - The rightmost column absorbs any leftover pixels (its `w = width - lastColX`).
   - The bottom row absorbs any leftover pixels (its `h = height - lastRowY`).
   - For each cell `(col, row)`: `nativeImage.createFromBuffer(pngBytes).crop({ x: cellX, y: cellY, width: cellW, height: cellH }).toPNG()` becomes the tile's `bytes`.
   - Cell `(col, row)` gets `x = cellX, y = cellY`.

By construction every produced tile is `≤ maxEdge` on each side.

## Section 2 — Tool result shape

`screenshot` tool result content array goes from:

```ts
[
  { type: 'image', data, mimeType: 'image/png' },
  { type: 'text',  text: JSON.stringify({ path, width, height, monitors }) },
]
```

to:

```ts
[
  ...tiles.map(t => ({ type: 'image', data: t.bytes.toString('base64'), mimeType: 'image/png' })),
  { type: 'text', text: JSON.stringify({
      path,
      width, height,                                 // source dims
      monitors,                                      // unchanged
      tiles: tiles.map((t, index) => ({ index, x: t.x, y: t.y, w: t.w, h: t.h })),
    })
  },
]
```

Image blocks appear in tile-index order. Text meta is always the last block.

**Region/window offsets.** `tileIfNeeded` is origin-agnostic — its tile `(x, y)` are within the source image. The screenshot handler in `sdk-client.ts` knows the capture's virtual-desktop origin (from `region.x/y`, from the window's kdotool bounds, or `(0, 0)` for full virtual desktop). It REBASES tile offsets onto the capture origin before emitting:

```ts
const origin = captureOrigin(captured, sArgs);  // see below
const tilesMeta = result.tiles.map((t, index) => ({
  index,
  x: origin.x + t.x,
  y: origin.y + t.y,
  w: t.w,
  h: t.h,
}));
```

`captureOrigin` derivation:
- If `sArgs.region` is set → `{ x: sArgs.region.x, y: sArgs.region.y }`.
- Else if `sArgs.window` is set → the kdotool-resolved window bounds top-left (the screenshot executor already computes this; expose it on `captured` if not already).
- Else → `{ x: 0, y: 0 }` (full virtual desktop).

`captured.monitors` is unchanged. If `captured` doesn't already surface the capture origin for the `window=` case, add it as `captured.origin: { x, y }`; the executor knows it.

## Section 3 — System prompt update

In `src/main/agent/sdk-client.ts`'s `SYSTEM_PROMPT` array:

Replace the current `screenshot` bullet line with:

```
'- screenshot(region?, window?): capture the virtual desktop as a PNG. Default is the full desktop (all monitors stitched); `region` crops by virtual-desktop coords; `window` (name pattern like "Firefox") crops to that window\'s bounds via kdotool — strongly preferred for iteration once a target window is identified, since it\'s much smaller and faster than a full capture. Result includes a `monitors` array with each display\'s {x, y, w, h} and a `tiles` array describing how the image was split.',
```

Add a new paragraph somewhere after the tool list (e.g., just before the "GUI workflow" header):

```
'When a screenshot is too large for a single image, it is split into TILES. The meta\'s `tiles` array lists each tile\'s virtual-desktop rect: `[{ index, x, y, w, h }, ...]`, in the same order the image attachments appear. To convert a pixel you see at `(ix, iy)` inside tile N to virtual-desktop coords for clicking: `(tiles[N].x + ix, tiles[N].y + iy)`. The image pixel pitch is always 1:1 with virtual-desktop pixels (no DPR scaling) so no further math is needed. When `tiles.length === 1`, the offset is `(0, 0)` for full-desktop captures and the region/window origin for crops — translation still works the same way.',
```

No other prompt edits.

## Section 4 — Testing

New tests in `src/main/screenshot/processor.test.ts`:

1. **Pass-through.** Build a 1200×900 synthetic PNG via `sharp`, call `tileIfNeeded(bytes, 1920)`, assert:
   - `tiles.length === 1`
   - `tiles[0].bytes === bytes` (same reference, no re-encode)
   - `tiles[0]` has `x: 0, y: 0, w: 1200, h: 900`
   - `fellBackToDownscale === false`

2. **2×1 split metadata.** A synthetic 2400×800 PNG with `maxEdge=1920` would need `cols=2, rows=1`. Because `nativeImage.crop` isn't available in vitest's Node runtime (same constraint that the existing test file already notes), use `vi.mock('electron', …)` to stub `nativeImage.createFromBuffer` to return an object with `crop({x,y,width,height})` returning `{ toPNG: () => Buffer.from(`tile-${x}-${y}-${width}x${height}`) }`. Assertions:
   - `tiles.length === 2`
   - `tiles[0]` = `{ x: 0,    y: 0, w: 1200, h: 800 }`
   - `tiles[1]` = `{ x: 1200, y: 0, w: 1200, h: 800 }`
   - `fellBackToDownscale === false`
   - Each `tiles[i].bytes` matches the stub's encoded marker (proves the crop pipeline got the right params).

3. **Cap fallback.** A synthetic 4000×4000 PNG with `maxEdge=1000` and `maxTiles=8` would compute `cols=4, rows=4 = 16 > 8`. Stub `downscaleIfNeeded` (or, since it's exported from the same module, stub via `vi.spyOn` on the module's own export) to return `{ bytes: Buffer.from('downscaled'), width: 1000, height: 1000, downscaled: true }`. Assert:
   - `tiles.length === 1`
   - `tiles[0].bytes` matches the stub's output
   - `tiles[0].w === 1000 && tiles[0].h === 1000`
   - `fellBackToDownscale === true`

No new tests in `sdk-client`; the existing `OTTO_FAKE_SDK` path exercises the screenshot tool, and the tile rebase logic is best validated by the smoke test below.

## Section 5 — Manual smoke test

On the actual 3440×1440 hardware:

1. `npm run dev`.
2. Ask Otto to take a full-desktop screenshot.
3. Expect 2 image blocks in the tool result + a meta JSON whose `tiles` array contains two entries with `x` offsets `0` and `1720` (or whatever floor-division yields for the actual width), each `w` ≈ 1720.
4. Ask Otto to click something on the right half of the desktop. The resulting `click(x, y)` arguments should land in `x ∈ [1720, 3440]`, proving the offset add worked.
5. Ask Otto to take a `window="Firefox"`-style capture. It should come back as a single tile (window is much narrower than 1920 in normal use); meta's `tiles[0].x/y` should equal Firefox's window bounds, not `(0, 0)`.

Failures here are the implementation getting `captureOrigin` wrong for the `window=` path or the tile rebase missing. Both are obvious from one click attempt.

## Files added / changed

**Modified:**
- `src/main/screenshot/processor.ts` — add `Tile`, `TileResult`, `tileIfNeeded`. `downscaleIfNeeded` stays.
- `src/main/screenshot/processor.test.ts` — three new tests.
- `src/main/screenshot/executor.ts` (likely) — surface `origin: { x, y }` on the `captured` result if it's not already there for the `window=` case. The screenshot tool handler needs to know the capture's virtual top-left.
- `src/main/agent/sdk-client.ts` — replace `downscaleIfNeeded` call in the real `screenshot` handler with `tileIfNeeded`. Emit one `image` block per tile. Add the rebased `tiles` array to the meta JSON. Update `SYSTEM_PROMPT` per Section 3. Apply the same change in the `OTTO_FAKE_SDK` fake-client branch so the dev path keeps working.

**New:** none.

## Open questions deferred to implementation

- Whether `captured.origin` already exists on the screenshot executor's return type (probably not — needs a one-line addition if absent). Implementer should grep first and add only if missing.
- Whether `ToolCallCard` in the renderer breaks visually on multi-image content. Not blocking; note as a follow-up if it does.
