/** Strip FTS5 operator characters so untrusted query text cannot break MATCH. */
export function sanitizeFtsQuery(q: string): string {
  const cleaned = q.replace(/["()*:^-]/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `${t}*`)
    .join(' ');
}
