import { nativeImage, screen } from 'electron';
import type { CaptureResult, PlatformAdapter } from '../platform';
import { withSelfHidden } from './self-mask';

/**
 * Post-action verification crop: a small native-resolution excerpt of the
 * desktop centered on where a click/double-click/drag just landed, captured
 * with the pointer rendered. Attached to the input tool's own result so the
 * model sees exactly where the action hit — and how the UI reacted — without
 * spending a whole screenshot round-trip per attempt.
 */

export const VERIFY_BOX_PX = 320;
// Crops are small, so we can afford better quality than full-desktop tiles.
const VERIFY_JPEG_QUALITY = 80;

export interface VerifyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VerifyCropResult {
  /** PNG bytes for the on-disk image-ref (renderer display). */
  png: Buffer;
  /** JPEG bytes for the API payload. */
  jpeg: Buffer;
  /** The crop's rect in virtual-desktop coords, for coordinate correction. */
  rect: VerifyRect;
}

/**
 * Box of `boxPx` square centered on the target, clamped to stay inside the
 * captured area (in virtual-desktop coords). Shrinks if the desktop itself is
 * smaller than the box.
 */
export function computeVerifyRect(
  target: { x: number; y: number },
  capture: { width: number; height: number; origin: { x: number; y: number }; scale: number },
  boxPx: number = VERIFY_BOX_PX
): VerifyRect {
  const vw = Math.round(capture.width / capture.scale);
  const vh = Math.round(capture.height / capture.scale);
  const w = Math.min(boxPx, vw);
  const h = Math.min(boxPx, vh);
  const x = Math.max(
    capture.origin.x,
    Math.min(target.x - Math.floor(w / 2), capture.origin.x + vw - w)
  );
  const y = Math.max(
    capture.origin.y,
    Math.min(target.y - Math.floor(h / 2), capture.origin.y + vh - h)
  );
  return { x, y, w, h };
}

/** Bounding box of all displays in virtual-desktop coords. */
function virtualDesktop(): { width: number; height: number; origin: { x: number; y: number }; scale: number } {
  const displays = screen.getAllDisplays();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of displays) {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  }
  if (!Number.isFinite(minX)) return { width: 0, height: 0, origin: { x: 0, y: 0 }, scale: 1 };
  return { width: maxX - minX, height: maxY - minY, origin: { x: minX, y: minY }, scale: 1 };
}

export async function captureVerifyCrop(
  adapter: PlatformAdapter,
  target: { x: number; y: number },
  boxPx: number = VERIFY_BOX_PX
): Promise<VerifyCropResult> {
  // Ask the adapter for just the box: on KDE that is a ~10ms KWin CaptureArea
  // instead of a full-desktop grab; elsewhere the adapter crops for us. Only
  // Otto windows overlapping the box need hiding.
  const rect = computeVerifyRect(target, virtualDesktop(), boxPx);
  const shot: CaptureResult = await withSelfHidden(
    () => adapter.screenshot.capture({ region: rect }),
    rect
  );
  const img = shot.image ?? nativeImage.createFromBuffer(shot.bytes);
  return { png: shot.bytes, jpeg: img.toJPEG(VERIFY_JPEG_QUALITY), rect };
}
