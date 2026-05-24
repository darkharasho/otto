import { nativeImage } from 'electron';

export interface ProcessResult {
  bytes: Buffer;
  width: number;
  height: number;
  downscaled: boolean;
}

/**
 * Read PNG dimensions from the IHDR chunk without invoking any image library.
 * sharp/libvips has been observed to abort the Electron main process with
 * `VObject::operator=: assertion failed` on Linux, so we keep image handling
 * inside Electron's `nativeImage` which is stable here.
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
    return { bytes: pngBytes, width, height, downscaled: false };
  }
  const scale = maxEdge / Math.max(width, height);
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);
  const img = nativeImage.createFromBuffer(pngBytes);
  const resized = img.resize({ width: targetW, height: targetH });
  return { bytes: resized.toPNG(), width: targetW, height: targetH, downscaled: true };
}

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
