import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { save } from './store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-screenshot-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('save', () => {
  it('writes the bytes under <configDir>/screenshots/<sessionId>/<uuid>.png and returns the path', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
    const p = await save(bytes, 's1', dir);
    expect(p).toMatch(new RegExp(`^${dir}/screenshots/s1/.+\\.png$`));
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p).equals(bytes)).toBe(true);
  });

  it('creates the per-session directory if missing', async () => {
    const bytes = Buffer.from('x');
    const p = await save(bytes, 'fresh-session', dir);
    expect(existsSync(path.dirname(p))).toBe(true);
  });

  it('produces distinct paths for two saves in the same session', async () => {
    const a = await save(Buffer.from('a'), 's1', dir);
    const b = await save(Buffer.from('b'), 's1', dir);
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.dirname(b));
  });
});
