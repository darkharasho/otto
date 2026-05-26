import { createHash } from 'node:crypto';
import { promises as fsp, createWriteStream } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import path from 'node:path';
import { logger } from '../logger';

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const ALLOWED_PREFIXES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];

export interface CachedImage {
  path: string;
  contentType: string;
}

export interface ImageCacheError {
  status: number;
  reason: string;
}

export class ImageCacheRejected extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

export interface ImageCacheDeps {
  cacheDir: string;
  /** Optional override for tests. Default uses global fetch + node DNS. */
  fetcher?: typeof fetch;
  resolveHost?: (host: string) => Promise<string>;
  /** Returns the on-disk timestamp guard so writes can be made deterministic in tests. */
  now?: () => number;
}

export class ImageCache {
  private readonly inflight = new Map<string, Promise<CachedImage>>();
  private readonly fetcher: typeof fetch;
  private readonly resolveHost: (host: string) => Promise<string>;

  constructor(private readonly deps: ImageCacheDeps) {
    this.fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);
    this.resolveHost = deps.resolveHost ?? (async (host) => (await dnsLookup(host)).address);
  }

  async get(url: string): Promise<CachedImage> {
    const inflight = this.inflight.get(url);
    if (inflight) return inflight;
    const promise = this.load(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, promise);
    return promise;
  }

  private async load(url: string): Promise<CachedImage> {
    const parsed = parseUrl(url);
    await this.assertNotPrivate(parsed.hostname);

    const key = sha256(url);
    const metaPath = path.join(this.deps.cacheDir, `${key}.json`);
    const existing = await readMeta(metaPath);
    if (existing && (await fileExists(existing.path))) return existing;

    await fsp.mkdir(this.deps.cacheDir, { recursive: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetcher(url, { signal: controller.signal, redirect: 'follow' });
      if (!res.ok) throw new ImageCacheRejected(502, `upstream ${res.status}`);

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
      if (!ALLOWED_PREFIXES.includes(contentType)) {
        throw new ImageCacheRejected(415, `disallowed content-type: ${contentType || '(missing)'}`);
      }
      const declaredLen = Number(res.headers.get('content-length') ?? '0');
      if (declaredLen > MAX_BYTES) throw new ImageCacheRejected(413, `declared size ${declaredLen} > ${MAX_BYTES}`);
      if (!res.body) throw new ImageCacheRejected(502, 'empty body');

      const ext = extFor(contentType);
      const filePath = path.join(this.deps.cacheDir, `${key}${ext}`);
      const tmpPath = `${filePath}.tmp`;
      await streamToFile(res.body, tmpPath, MAX_BYTES);
      await fsp.rename(tmpPath, filePath);
      const meta: CachedImage = { path: filePath, contentType };
      await fsp.writeFile(metaPath, JSON.stringify(meta), 'utf8');
      return meta;
    } catch (err) {
      if (err instanceof ImageCacheRejected) throw err;
      if ((err as { name?: string }).name === 'AbortError') {
        throw new ImageCacheRejected(504, 'fetch timeout or size cap exceeded');
      }
      logger.warn(`image-cache: fetch failed for ${url}: ${(err as Error).message}`);
      throw new ImageCacheRejected(502, 'fetch failed');
    } finally {
      clearTimeout(timer);
    }
  }

  private async assertNotPrivate(hostname: string): Promise<void> {
    if (!hostname) throw new ImageCacheRejected(400, 'missing hostname');
    // Block literal IPs first so a clever attacker can't sneak past DNS by
    // passing http://127.0.0.1 directly.
    if (isPrivateAddress(hostname)) throw new ImageCacheRejected(403, `blocked host ${hostname}`);
    try {
      const ip = await this.resolveHost(hostname);
      if (isPrivateAddress(ip)) throw new ImageCacheRejected(403, `blocked host ${hostname} → ${ip}`);
    } catch (err) {
      if (err instanceof ImageCacheRejected) throw err;
      throw new ImageCacheRejected(502, `dns failed for ${hostname}`);
    }
  }
}

function parseUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ImageCacheRejected(400, 'invalid url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ImageCacheRejected(400, `unsupported protocol ${u.protocol}`);
  }
  return u;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function extFor(contentType: string): string {
  switch (contentType) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    case 'image/avif': return '.avif';
    default: return '.bin';
  }
}

async function fileExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function readMeta(metaPath: string): Promise<CachedImage | null> {
  try {
    const raw = await fsp.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw) as CachedImage;
    if (typeof parsed.path === 'string' && typeof parsed.contentType === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

async function streamToFile(body: ReadableStream<Uint8Array>, dest: string, maxBytes: number): Promise<void> {
  const reader = body.getReader();
  const writer = createWriteStream(dest);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        writer.destroy();
        await fsp.rm(dest, { force: true });
        throw new ImageCacheRejected(413, `streamed size > ${maxBytes}`);
      }
      if (!writer.write(value)) await new Promise<void>((r) => writer.once('drain', () => r()));
    }
    await new Promise<void>((resolve, reject) => {
      writer.end((err: unknown) => err ? reject(err as Error) : resolve());
    });
  } catch (err) {
    writer.destroy();
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw err;
  }
}

// Conservative private-address guard: IPv4 loopback/link-local/RFC1918,
// IPv6 loopback / unique-local / link-local, plus DNS names that resolve
// to localhost-shaped hostnames.
export function isPrivateAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  // IPv4 dotted
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale 100.64/10
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  // IPv6: loopback, unspecified, link-local (fe80::/10), unique local (fc00::/7).
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}
