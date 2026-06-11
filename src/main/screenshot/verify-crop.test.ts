import { describe, it, expect } from 'vitest';
import { computeVerifyRect } from './verify-crop';

// NOTE: captureVerifyCrop's crop path uses Electron's `nativeImage`, which
// can't load in vitest's Node runtime (same constraint as processor.test.ts).
// The geometry — where misses would actually come from — is pure and tested.

const DESKTOP = { width: 4480, height: 1440, origin: { x: 0, y: 0 }, scale: 1 };

describe('computeVerifyRect', () => {
  it('centers the box on the target', () => {
    const r = computeVerifyRect({ x: 1000, y: 700 }, DESKTOP, 320);
    expect(r).toEqual({ x: 840, y: 540, w: 320, h: 320 });
  });

  it('clamps at the top-left edge', () => {
    const r = computeVerifyRect({ x: 10, y: 5 }, DESKTOP, 320);
    expect(r).toEqual({ x: 0, y: 0, w: 320, h: 320 });
  });

  it('clamps at the bottom-right edge', () => {
    const r = computeVerifyRect({ x: 4475, y: 1438 }, DESKTOP, 320);
    expect(r).toEqual({ x: 4480 - 320, y: 1440 - 320, w: 320, h: 320 });
  });

  it('shrinks when the captured area is smaller than the box', () => {
    const r = computeVerifyRect({ x: 100, y: 100 }, { width: 200, height: 150, origin: { x: 0, y: 0 }, scale: 1 }, 320);
    expect(r).toEqual({ x: 0, y: 0, w: 200, h: 150 });
  });

  it('honors a non-zero virtual-desktop origin', () => {
    const r = computeVerifyRect(
      { x: -500, y: 100 },
      { width: 1920, height: 1080, origin: { x: -1920, y: 0 }, scale: 1 },
      320
    );
    expect(r).toEqual({ x: -660, y: 0, w: 320, h: 320 });
  });

  it('divides out the device scale factor when computing virtual bounds', () => {
    // 2x scale: 5120 device px wide capture = 2560 virtual px.
    const r = computeVerifyRect(
      { x: 2550, y: 100 },
      { width: 5120, height: 2880, origin: { x: 0, y: 0 }, scale: 2 },
      320
    );
    expect(r).toEqual({ x: 2560 - 320, y: 0, w: 320, h: 320 });
  });
});
