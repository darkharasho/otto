export function normalizeFactLine(line: string): string {
  return line
    .replace(/^\s*-\s*\(\d{4}-\d{2}-\d{2}\)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
