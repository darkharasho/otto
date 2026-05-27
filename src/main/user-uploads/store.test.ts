import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extOf } from './store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'otto-uploads-test-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('saveUserUpload', () => {
  it('writes the bytes under <configDir>/user-uploads/<sessionId>/<uuid>.<ext>', async () => {
    // Minimal valid PNG: 1×1 transparent pixel.
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
      'hex',
    );
    vi.doMock('electron', () => ({
      nativeImage: {
        createFromBuffer: () => ({
          getSize: () => ({ width: 1, height: 1 }),
        }),
      },
    }));
    vi.resetModules();
    const { saveUserUpload: saveUserUploadMocked } = await import('./store');
    const ref = await saveUserUploadMocked(png, 'image/png', 'sess-1', dir);
    expect(ref.type).toBe('image-ref');
    expect(ref.source).toBe('user');
    expect(ref.sessionId).toBe('sess-1');
    expect(ref.mimeType).toBe('image/png');
    expect(ref.width).toBeGreaterThan(0);
    expect(ref.height).toBeGreaterThan(0);
    const onDisk = readFileSync(ref.path);
    expect(onDisk.equals(png)).toBe(true);
    expect(ref.path).toContain(path.join('user-uploads', 'sess-1'));
    expect(ref.path.endsWith('.png')).toBe(true);
    vi.doUnmock('electron');
    vi.resetModules();
  });

  it('extOf maps every supported mime', () => {
    expect(extOf('image/png')).toBe('png');
    expect(extOf('image/jpeg')).toBe('jpg');
    expect(extOf('image/webp')).toBe('webp');
    expect(extOf('image/gif')).toBe('gif');
  });

  it('rejects unsupported mime types at runtime', async () => {
    vi.doMock('electron', () => ({
      nativeImage: {
        createFromBuffer: () => ({
          getSize: () => ({ width: 1, height: 1 }),
        }),
      },
    }));
    vi.resetModules();
    const { saveUserUpload: saveUserUploadMocked } = await import('./store');
    await expect(
      saveUserUploadMocked(Buffer.from([0]), 'image/avif' as unknown as 'image/png', 'sess-1', dir),
    ).rejects.toThrow(/unsupported mimeType/);
    vi.doUnmock('electron');
    vi.resetModules();
  });
});
