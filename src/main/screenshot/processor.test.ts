import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { downscaleIfNeeded, tileIfNeeded } from './processor';

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

describe('tileIfNeeded', () => {
  it('returns the input unchanged when both edges are within maxEdge', async () => {
    const bytes = await makePng(1200, 900);
    const r = await tileIfNeeded(bytes, 1920);
    expect(r.fellBackToDownscale).toBe(false);
    expect(r.width).toBe(1200);
    expect(r.height).toBe(900);
    expect(r.tiles).toHaveLength(1);
    expect(r.tiles[0]!.bytes).toBe(bytes);
    expect(r.tiles[0]!.x).toBe(0);
    expect(r.tiles[0]!.y).toBe(0);
    expect(r.tiles[0]!.w).toBe(1200);
    expect(r.tiles[0]!.h).toBe(900);
  });

  it('splits a 2400x800 image into two 1200x800 tiles at maxEdge=1920', async () => {
    const bytes = await makePng(2400, 800);
    // nativeImage.crop is unavailable in vitest's Node runtime; stub it.
    vi.doMock('electron', () => ({
      nativeImage: {
        createFromBuffer: () => ({
          crop: ({ x, y, width, height }: { x: number; y: number; width: number; height: number }) => ({
            toPNG: () => Buffer.from(`tile-${x}-${y}-${width}x${height}`),
          }),
          getSize: () => ({ width: 2400, height: 800 }),
        }),
      },
    }));
    vi.resetModules();
    const { tileIfNeeded: tileMocked } = await import('./processor');
    const r = await tileMocked(bytes, 1920);
    expect(r.fellBackToDownscale).toBe(false);
    expect(r.tiles).toHaveLength(2);
    expect(r.tiles[0]).toMatchObject({ x: 0, y: 0, w: 1200, h: 800 });
    expect(r.tiles[1]).toMatchObject({ x: 1200, y: 0, w: 1200, h: 800 });
    expect(r.tiles[0]!.bytes).toEqual(Buffer.from('tile-0-0-1200x800'));
    expect(r.tiles[1]!.bytes).toEqual(Buffer.from('tile-1200-0-1200x800'));
    vi.doUnmock('electron');
    vi.resetModules();
  });

  it('falls back to downscale when the grid would exceed maxTiles', async () => {
    const bytes = await makePng(4000, 4000);
    vi.doMock('electron', () => ({
      nativeImage: {
        createFromBuffer: () => ({
          resize: () => ({ toPNG: () => Buffer.from('downscaled-1000x1000') }),
          crop: () => ({ toPNG: () => Buffer.from('unexpected-crop') }),
          getSize: () => ({ width: 4000, height: 4000 }),
        }),
      },
    }));
    vi.resetModules();
    const { tileIfNeeded: tileMocked } = await import('./processor');
    const r = await tileMocked(bytes, 1000, 8); // 4x4 = 16 > 8 → fallback
    expect(r.fellBackToDownscale).toBe(true);
    expect(r.tiles).toHaveLength(1);
    expect(r.tiles[0]!.bytes).toEqual(Buffer.from('downscaled-1000x1000'));
    expect(r.tiles[0]!.w).toBe(1000);
    expect(r.tiles[0]!.h).toBe(1000);
    vi.doUnmock('electron');
    vi.resetModules();
  });
});
