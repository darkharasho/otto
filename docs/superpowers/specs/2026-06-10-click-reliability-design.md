# Click Reliability — Absolute Pointer Motion + Post-Action Verification

**Date:** 2026-06-10
**Status:** Approved (approach A: full stack, this machine first)

## Problem

Otto's clicks frequently miss and take several attempts. Two independent layers cause this:

1. **Open-loop relative motion (Linux/Wayland).** The portal input path only sends
   relative deltas (`NotifyPointerMotion`), which pass through KWin/libinput pointer
   acceleration. Otto corner-homes to (0,0) and walks to the target in ≤150px chunks,
   assuming the accel curve has slope exactly 1.0 below the knee. Any non-flat pointer
   accel/speed setting produces multiplicative error that grows with distance. A click
   on a wide desktop also costs up to ~35 D-Bus motion events (slow, visibly janky).
2. **Fuzzy aim + expensive retries.** The model aims from screenshots tiled/downscaled
   to 1280px edges at JPEG q70, and the system prompt normalizes failure ("~10–50px
   error is normal"). Verifying a click requires a whole new full-desktop screenshot
   per attempt, so misses compound into many slow turns.

## Design

### 1. Absolute pointer motion via ScreenCast-backed portal session (`src/main/input/portal.ts`)

`NotifyPointerMotionAbsolute(stream, x, y)` positions the cursor deterministically, but
only when the session carries a ScreenCast stream (without one, KWin misinterprets the
coords). Extend the handshake on the existing combined session:

- After `CreateSession` + `RemoteDesktop.SelectDevices`, also call
  `ScreenCast.SelectSources(session, { types: MONITOR(1), multiple: true })` on the
  same session object (spec-supported combination; restore token still flows through
  `RemoteDesktop.Start`).
- Parse `streams` from the `Start` response: `[{ nodeId, position: (x, y), size: (w, h) }]`
  — position/size are in virtual-desktop logical coordinates.
- `rawMove(x, y)`: when streams exist, find the stream whose rect contains the target
  (clamp to the nearest if none) and emit ONE
  `NotifyPointerMotionAbsolute(session, {}, nodeId, x - stream.x, y - stream.y)`.
  Update `lastSentCursor` as before.
- **Drags interpolate**: with the button held, emit absolute motions every ~30px along
  the path so drag targets (DnD, sliders, games) see continuous motion, then land
  exactly on the endpoint.
- **Fallback preserved**: if `SelectSources` fails (older portal, user denial) or
  `Start` returns no streams, or an absolute call errors at runtime, fall back to the
  existing corner-home + chunked relative path. No behavior change on that path.

Trade-off: an open ScreenCast source may show KDE's "screen is being shared" indicator
while the input session is alive. Accepted; the fallback covers denial.

### 2. Post-action verification crop (`src/main/agent/sdk-client.ts`)

After `click` / `double_click` / `drag` execute, capture a native-resolution region
crop (~320×320, clamped to virtual-desktop bounds) centered on the action's endpoint,
with the pointer rendered (Spectacle `-p`), and attach it to the SAME tool result as a
JPEG image block plus a meta line `{ verify: { x, y, w, h } }` describing the crop's
virtual-desktop rect. The model sees exactly where the click landed — and what the UI
did — without a separate screenshot round-trip. `move`/`scroll`/`type`/`key` results
stay text-only (no capture latency on non-committal actions).

Capture goes through the existing `withSelfHidden(capture(...))` path. The crop is
small (~tens of KB JPEG), so history bloat is negligible. If the verification capture
fails, the tool result degrades to the current `'ok'` text — never fail the input
action because verification couldn't capture.

Bounds clamping: the region capture path currently throws on out-of-bounds rects; the
verification rect is clamped against the monitor bounds (from the capture result's
`monitors`/full-desktop knowledge) before requesting the crop.

### 3. Prompt + tool description updates (`sdk-client.ts`, `tools.ts`)

- `click`/`double_click`/`drag` descriptions: note the result embeds a zoomed
  verification image centered on the endpoint with the cursor visible; inspect it
  before deciding to re-click or take a full screenshot.
- Linux GUI workflow step 5: replace "take another screenshot to confirm" with "check
  the verification crop attached to the click result; only take a fresh screenshot if
  the consequence extends beyond the crop".
- Aiming guidance: for targets smaller than ~20px, take a `region` screenshot first —
  region crops are native resolution while full-desktop captures may be downscaled.
- Drop the "~10–50px error is normal" framing: motion delivery is now exact; residual
  error is the model's own pixel estimate, and the verification crop closes that loop
  in one step.

## Out of scope

- macOS parity (AppleScript/CGEvent path unchanged; verification crop applies there
  automatically since it lives above the platform adapter).
- Windows support.
- Raising `MAX_SCREENSHOT_EDGE` / JPEG quality (token-cost trade, revisit separately).

## Testing

- `portal.test.ts` (stub bus): handshake issues `SelectSources` on the same session;
  `Start` streams are parsed; click uses one `NotifyPointerMotionAbsolute` with
  stream-local coords; multi-monitor target maps to the containing stream; drag
  interpolates absolute motions and holds the button; missing streams / SelectSources
  failure falls back to corner-homing (existing tests must pass unchanged); runtime
  absolute-call failure falls back to relative.
- sdk-client input-tool handler: click result includes image block + verify meta;
  verification capture failure degrades to text-only result.
