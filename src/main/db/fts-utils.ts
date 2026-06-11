/**
 * Make untrusted query text safe for FTS5 MATCH without losing precision.
 * Each whitespace token is emitted as a quoted prefix phrase (`"multi-monitor"*`),
 * so punctuated terms keep their adjacency (the tokenizer splits them into an
 * exact phrase) instead of degrading into independent words, and FTS operators
 * (AND/OR/NOT/NEAR, parens, column filters) are neutralized by the quoting.
 */
export function sanitizeFtsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    // A token must contain something the tokenizer will index; bare operator
    // junk like `()` or `--` would otherwise produce an empty phrase.
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .map((t) => `"${t}"*`)
    .join(' ');
}
