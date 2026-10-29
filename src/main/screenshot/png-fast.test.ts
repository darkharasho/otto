import { describe, it, expect } from 'vitest';
import { inflateSync, crc32 } from 'node:zlib';
import { encodePngFromBgra } from './png-fast';

interface Chunk { type: string; data: Buffer; crc: number; }

function readChunks(png: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  let o = 8;
  while (o < png.length) {
    const len = png.readUInt32BE(o);
    const type = png.toString('latin1', o + 4, o + 8);
    const data = png.subarray(o + 8, o + 8 + len);
    const crc = png.readUInt32BE(o + 8 + len);
    chunks.push({ type, data, crc });
    o += 12 + len;
  }
  return chunks;
}

describe('encodePngFromBgra', () => {
  // 2×2: blue, green / red, translucent white (BGRA byte order).
  const bgra = Buffer.from([
    255, 0, 0, 255,   0, 255, 0, 255,
    0, 0, 255, 255,   255, 255, 255, 128,
  ]);

  it('writes a valid PNG signature, IHDR, IDAT and IEND with correct CRCs', async () => {
    const png = await encodePngFromBgra(bgra, 2, 2);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const chunks = readChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    for (const c of chunks) {
      expect(c.crc).toBe(crc32(Buffer.concat([Buffer.from(c.type, 'latin1'), c.data])));
    }
    const ihdr = chunks[0]!.data;
    expect(ihdr.readUInt32BE(0)).toBe(2);
    expect(ihdr.readUInt32BE(4)).toBe(2);
    expect([ihdr[8], ihdr[9]]).toEqual([8, 6]); // 8-bit RGBA
  });

  it('stores scanlines as filter-0 RGBA (B and R swapped from the input)', async () => {
    const png = await encodePngFromBgra(bgra, 2, 2);
    const raw = inflateSync(readChunks(png)[1]!.data);
    expect([...raw]).toEqual([
      0, 0, 0, 255, 255,   0, 255, 0, 255,
      0, 255, 0, 0, 255,   255, 255, 255, 128,
    ]);
  });

  it('rejects a bitmap smaller than width*height*4', async () => {
    await expect(encodePngFromBgra(Buffer.alloc(8), 2, 2)).rejects.toThrow(/smaller/);
  });
});
