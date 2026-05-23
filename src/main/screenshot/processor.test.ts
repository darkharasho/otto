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

  // NOTE: the resize path uses Electron's `nativeImage`, which can't be loaded
  // from vitest's Node runtime. The "no resize needed" path above is the bulk
  // of real-world usage. Resize-path coverage relies on the integration tests
  // and manual verification.
});
