import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { downscaleIfNeeded } from './processor';

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
}

describe('downscaleIfNeeded', () => {
  it('returns the input unchanged when longest edge is within the budget', async () => {
    const bytes = await makePng(800, 600);
    const r = await downscaleIfNeeded(bytes, 4096);
    expect(r.downscaled).toBe(false);
    expect(r.width).toBe(800);
    expect(r.height).toBe(600);
    expect(r.bytes).toBe(bytes);
  });

  it('downscales when longest edge exceeds the budget, preserving aspect', async () => {
    const bytes = await makePng(8000, 4000);
    const r = await downscaleIfNeeded(bytes, 4096);
    expect(r.downscaled).toBe(true);
    expect(r.width).toBe(4096);
    expect(r.height).toBeGreaterThanOrEqual(2047);
    expect(r.height).toBeLessThanOrEqual(2049);
    expect(r.bytes).not.toBe(bytes);
  });

  it('downscales a tall image by height when height is the longest edge', async () => {
    const bytes = await makePng(2000, 8000);
    const r = await downscaleIfNeeded(bytes, 4096);
    expect(r.downscaled).toBe(true);
    expect(r.height).toBe(4096);
    expect(r.width).toBeGreaterThanOrEqual(1023);
    expect(r.width).toBeLessThanOrEqual(1025);
  });
});
