import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveImageRequest } from './protocol';

let root: string;
let outsideRoot: string;

beforeAll(() => {
  outsideRoot = mkdtempSync(path.join(os.tmpdir(), 'otto-outside-'));
  writeFileSync(path.join(outsideRoot, 'secret.png'), 'evil');
  root = mkdtempSync(path.join(os.tmpdir(), 'otto-shots-'));
  const sessDir = path.join(root, 's1');
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(path.join(sessDir, 'good.png'), 'png');
  symlinkSync(path.join(outsideRoot, 'secret.png'), path.join(sessDir, 'evil.png'));
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outsideRoot, { recursive: true, force: true });
});

describe('resolveImageRequest', () => {
  it('serves a valid file', () => {
    const r = resolveImageRequest('otto-image://s1/good.png', root);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.absPath).toBe(path.join(root, 's1', 'good.png'));
  });
  it('404s on path traversal in segment', () => {
    expect(resolveImageRequest('otto-image://s1/..%2Fevil.png', root).ok).toBe(false);
  });
  it('404s on missing file', () => {
    expect(resolveImageRequest('otto-image://s1/missing.png', root).ok).toBe(false);
  });
  it('404s on bad sessionId', () => {
    expect(resolveImageRequest('otto-image://has spaces/good.png', root).ok).toBe(false);
  });
  it('404s on non-png extension', () => {
    expect(resolveImageRequest('otto-image://s1/good.txt', root).ok).toBe(false);
  });
  it('404s on symlink pointing outside root', () => {
    expect(resolveImageRequest('otto-image://s1/evil.png', root).ok).toBe(false);
  });

  it('serves .jpg files', () => {
    const sessDir = path.join(root, 's1');
    writeFileSync(path.join(sessDir, 'photo.jpg'), 'jpg');
    const r = resolveImageRequest('otto-image://s1/photo.jpg', root);
    expect(r.ok).toBe(true);
  });

  it('serves .jpeg, .webp, .gif files', () => {
    const sessDir = path.join(root, 's1');
    for (const ext of ['jpeg', 'webp', 'gif']) {
      writeFileSync(path.join(sessDir, `x.${ext}`), ext);
      expect(resolveImageRequest(`otto-image://s1/x.${ext}`, root).ok).toBe(true);
    }
  });

  it('still 404s on non-image extensions', () => {
    expect(resolveImageRequest('otto-image://s1/good.txt', root).ok).toBe(false);
  });
});
