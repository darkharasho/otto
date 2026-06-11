import { nativeImage } from 'electron';
import type { CaptureResult, PlatformAdapter } from '../platform';

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

export async function captureVerifyCrop(
  adapter: PlatformAdapter,
  target: { x: number; y: number },
  boxPx: number = VERIFY_BOX_PX
): Promise<VerifyCropResult> {
  const full: CaptureResult = await adapter.screenshot.capture({});
  // Same convention as the platform adapters' region path: image pixels are
  // virtual-desktop coords times the primary monitor's scale factor.
  const scale = full.monitors[0]?.scale || 1;
  const rect = computeVerifyRect(target, { width: full.width, height: full.height, origin: full.origin, scale }, boxPx);
  const img = nativeImage.createFromBuffer(full.bytes);
  const cropped = img.crop({
    x: Math.round((rect.x - full.origin.x) * scale),
    y: Math.round((rect.y - full.origin.y) * scale),
    width: Math.round(rect.w * scale),
    height: Math.round(rect.h * scale),
  });
  return { png: cropped.toPNG(), jpeg: cropped.toJPEG(VERIFY_JPEG_QUALITY), rect };
}
