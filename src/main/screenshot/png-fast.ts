import { deflate, constants as zc } from 'node:zlib';
import { promisify } from 'node:util';

const deflateAsync = promisify(deflate);

/**
 * Minimal PNG encoder for raw BGRA screen captures. Electron's
 * nativeImage.toPNG() spends ~750ms on a 6880×1440 desktop (max compression,
 * on the main thread); this does the byte shuffle in JS and the deflate at
 * level 1 on libuv's threadpool, so a full-desktop capture stays well under
 * the time it took to grab. Output is a standard 8-bit RGBA PNG (no filters),
 * a bit larger on disk than nativeImage's.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer, crc = 0xffffffff): number {
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return crc;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = (crc32(data, crc32(head.subarray(4))) ^ 0xffffffff) >>> 0;
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc, 0);
  return Buffer.concat([head, data, tail]);
}

/** Tightly packed BGRA (stride == width * 4) → PNG bytes. */
export async function encodePngFromBgra(bgra: Buffer, width: number, height: number): Promise<Buffer> {
  const rowBytes = width * 4;
  if (bgra.length < rowBytes * height) throw new Error('bitmap smaller than width*height*4');
  // Each scanline: filter byte 0 (None) + RGBA pixels.
  const raw = Buffer.allocUnsafe(height * (rowBytes + 1));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    let i = y * rowBytes;
    const end = i + rowBytes;
    for (; i < end; i += 4) {
      raw[o++] = bgra[i + 2]!;
      raw[o++] = bgra[i + 1]!;
      raw[o++] = bgra[i]!;
      raw[o++] = bgra[i + 3]!;
    }
  }
  const idat = await deflateAsync(raw, { level: 1, strategy: zc.Z_DEFAULT_STRATEGY });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
