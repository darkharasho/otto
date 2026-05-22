import sharp from 'sharp';

export interface ProcessResult {
  bytes: Buffer;
  width: number;
  height: number;
  downscaled: boolean;
}

export async function downscaleIfNeeded(
  pngBytes: Buffer,
  maxEdge: number
): Promise<ProcessResult> {
  const meta = await sharp(pngBytes).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
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
