// Resolves a markdown-image `src` to a URL that goes through Otto's local
// image cache so (a) the network fetch happens in main rather than the
// renderer (preserves IP privacy from third-party hosts), and (b) the asset
// is reused across sessions instead of re-fetched every render.
//
// Two render contexts:
//   - 'electron':  desktop chat + overlay. Uses the custom otto-img:// scheme
//                  registered in main.
//   - 'remote':    PWA on mobile. Calls the bridge's /image endpoint with the
//                  bearer token in the query string (<img> can't send headers).

export interface RemoteContext {
  kind: 'remote';
  /** Bearer token issued at pairing time. Required to hit /image. */
  token: string;
  /** Base path for the bridge; defaults to '' (same origin). */
  basePath?: string;
}

export type ImageSrcContext = { kind: 'electron' } | RemoteContext;

const MAX_LENGTH = 4096;

export function toLocalImageSrc(rawSrc: string | undefined, ctx: ImageSrcContext): string | null {
  if (!rawSrc) return null;
  const src = rawSrc.trim();
  if (!src) return null;
  // data: URLs render directly — no fetch needed and proxying them would just
  // bloat the URL bar.
  if (src.startsWith('data:')) return src;
  if (src.length > MAX_LENGTH) return null;
  // Only http/https go through the cache. Anything else (file://, javascript:,
  // about:, etc.) is rejected so a hallucinated URL can't escape the proxy.
  let parsed: URL;
  try { parsed = new URL(src); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const encoded = base64UrlEncode(src);
  if (ctx.kind === 'electron') {
    return `otto-img:///?u=${encoded}`;
  }
  const base = ctx.basePath ?? '';
  return `${base}/image?u=${encoded}&token=${encodeURIComponent(ctx.token)}`;
}

function base64UrlEncode(s: string): string {
  // Browser + Node both expose btoa; fall back to Buffer when not present.
  if (typeof btoa === 'function') {
    const bin = unescape(encodeURIComponent(s));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return Buffer.from(s, 'utf8').toString('base64url');
}
