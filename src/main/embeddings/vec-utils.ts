/**
 * Embeddings from the real model are unit-normalized; a (near-)zero vector
 * means the embedder produced no usable signal. Distance math on such vectors
 * is meaningless (two zero vectors sit at distance 0 and would read as
 * "identical"), so semantic comparisons must skip them.
 */
export function hasEmbeddingSignal(vec: Float32Array): boolean {
  let normSq = 0;
  for (let i = 0; i < vec.length; i += 1) normSq += vec[i]! * vec[i]!;
  return normSq > 0.25;
}
