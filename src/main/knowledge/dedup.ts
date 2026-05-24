export function normalizeFactLine(line: string): string {
  return line
    .replace(/^\s*-\s*\(\d{4}-\d{2}-\d{2}\)\s*/, '')
    // Strip any number of leading markdown bullet prefixes ("- ", "- - ", ...)
    // so a fact re-imported from its own rendered markdown projection collapses
    // back onto the original row instead of inserting a dashed duplicate.
    .replace(/^(?:\s*-\s+)+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
