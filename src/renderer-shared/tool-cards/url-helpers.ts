export function favicon(url: string): string {
  try { return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(url).hostname}`; }
  catch { return ''; }
}

export function hostname(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}
