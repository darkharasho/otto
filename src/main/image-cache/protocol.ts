import { protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';
import { logger } from '../logger';
import { ImageCache, ImageCacheRejected } from './cache';

export const OTTO_IMAGE_SCHEME = 'otto-img';

export function registerImageProtocolPrivileges(): void {
  // Standard so URLs parse cleanly; secure so the renderer treats responses
  // like normal media (no mixed-content warnings); supportFetchAPI so
  // <img>/fetch() both work.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: OTTO_IMAGE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
    },
  ]);
}

export function registerImageProtocolHandler(cache: ImageCache): void {
  protocol.handle(OTTO_IMAGE_SCHEME, async (request) => {
    const url = decodeRequestUrl(request.url);
    if (!url) return new Response('bad url', { status: 400 });
    try {
      const cached = await cache.get(url);
      return await net.fetch(pathToFileURL(cached.path).toString(), {
        headers: { 'content-type': cached.contentType },
      });
    } catch (err) {
      if (err instanceof ImageCacheRejected) return new Response(err.reason, { status: err.status });
      logger.warn(`image-cache: protocol error: ${(err as Error).message}`);
      return new Response('internal error', { status: 500 });
    }
  });
}

function decodeRequestUrl(reqUrl: string): string | null {
  try {
    const u = new URL(reqUrl);
    const encoded = u.searchParams.get('u');
    if (!encoded) return null;
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}
