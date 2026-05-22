import sharp from 'sharp';

export interface ProcessResult {
  bytes: Buffer;
  width: number;
  height: number;
  downscaled: boolean;
}

/**
 * Read PNG dimensions from the IHDR chunk without invoking sharp/libvips.
 * Sharp's `metadata()` call has been observed to abort the Electron process
 * with a libvips assertion on some Linux builds, so we avoid touching sharp
 * unless we actually need to resize.
 */
function readPngDims(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (bytes.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export async function downscaleIfNeeded(
  pngBytes: Buffer,
  maxEdge: number
): Promise<ProcessResult> {
  const native = readPngDims(pngBytes);
  let width: number;
  let height: number;
  if (native) {
    width = native.width;
    height = native.height;
  } else {
    const meta = await sharp(pngBytes).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  }
  if (!width || !height) {
    throw new Error('could not read PNG dimensions');
  }
  if (Math.max(width, height) <= maxEdge) {
    return { bytes: pngBytes, width, height, downscaled: false };
  }
  const scale = maxEdge / Math.max(width, height);
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);
  const out = await sharp(pngBytes).resize(targetW, targetH).png().toBuffer();
  return { bytes: out, width: targetW, height: targetH, downscaled: true };
}
