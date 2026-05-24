import type { Embedder } from './embedder';

/**
 * Deterministic embedder for tests. Same input → same vector. Different inputs
 * generally differ. Optional `overrides` lets a test pin specific texts to
 * specific vectors (useful for forcing exact ranking outcomes).
 */
export function createStubEmbedder(overrides: Record<string, Float32Array> = {}): Embedder {
  function hashSeed(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h || 1;
  }
  function makeVec(text: string): Float32Array {
    if (overrides[text]) return overrides[text]!;
    const seed = hashSeed(text);
    const v = new Float32Array(384);
    let s = seed;
    for (let i = 0; i < 384; i += 1) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      s = s >>> 0;
      v[i] = ((s % 2000) - 1000) / 1000;
    }
    let norm = 0;
    for (let i = 0; i < 384; i += 1) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 384; i += 1) v[i] = v[i]! / norm;
    return v;
  }
  return {
    dim: 384,
    isAvailable: true,
    async embed(text) {
      return makeVec(text);
    },
    async embedBatch(texts) {
      return texts.map((t) => makeVec(t));
    },
  };
}
