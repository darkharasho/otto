import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStubEmbedder } from './stub';

describe('createStubEmbedder', () => {
  it('returns deterministic vectors of dim 384', async () => {
    const e = createStubEmbedder();
    const a = await e.embed('hello');
    const b = await e.embed('hello');
    expect(a.length).toBe(384);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('returns different vectors for different inputs', async () => {
    const e = createStubEmbedder();
    const a = await e.embed('alpha');
    const b = await e.embed('beta');
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('embedBatch returns one vector per input', async () => {
    const e = createStubEmbedder();
    const vs = await e.embedBatch(['a', 'b', 'c']);
    expect(vs).toHaveLength(3);
    expect(vs[0]!.length).toBe(384);
  });

  it('supports override map for controlled vectors in tests', async () => {
    const e = createStubEmbedder({
      'audio stutter': new Float32Array(384).fill(0.5),
    });
    const v = await e.embed('audio stutter');
    expect(v[0]).toBe(0.5);
  });
});

describe('getEmbedder() singleton + disable env', () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.OTTO_DISABLE_EMBEDDINGS;
    vi.resetModules();
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OTTO_DISABLE_EMBEDDINGS;
    else process.env.OTTO_DISABLE_EMBEDDINGS = originalEnv;
  });

  it('returns a no-op embedder when OTTO_DISABLE_EMBEDDINGS=1', async () => {
    process.env.OTTO_DISABLE_EMBEDDINGS = '1';
    const { getEmbedder } = await import('./embedder');
    const e = getEmbedder();
    const v = await e.embed('x');
    expect(v.length).toBe(384);
    expect(Array.from(v).every((n) => n === 0)).toBe(true);
  });

  it('caches across calls (singleton)', async () => {
    process.env.OTTO_DISABLE_EMBEDDINGS = '1';
    const { getEmbedder } = await import('./embedder');
    expect(getEmbedder()).toBe(getEmbedder());
  });
});
