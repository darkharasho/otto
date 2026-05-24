export function normalizeFactLine(line: string): string {
  return line
    .replace(/^\s*-\s*\(\d{4}-\d{2}-\d{2}\)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function filterNovelFacts(candidates: string[], existing: string): string[] {
  const seen = new Set<string>();
  for (const line of existing.split('\n')) {
    const n = normalizeFactLine(line);
    if (n) seen.add(n);
  }
  const out: string[] = [];
  for (const c of candidates) {
    const n = normalizeFactLine(c);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(c.trim());
  }
  return out;
}
