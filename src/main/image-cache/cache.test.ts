import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ImageCache, ImageCacheRejected, isPrivateAddress } from './cache';

function pngBuffer(byteCount = 64): Buffer {
  // Minimal PNG signature + filler so content-type can stay image/png and the
  // file looks plausible. We don't actually decode.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const filler = Buffer.alloc(Math.max(0, byteCount - sig.length), 0);
  return Buffer.concat([sig, filler]);
}

function mockResponse(buf: Buffer, contentType = 'image/png'): Response {
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: { 'content-type': contentType, 'content-length': String(buf.byteLength) },
  });
}

describe('ImageCache', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'otto-image-cache-'));
    return async () => { await rm(dir, { recursive: true, force: true }); };
  });

  it('downloads and caches an image on first request', async () => {
    let calls = 0;
    const cache = new ImageCache({
      cacheDir: dir,
      resolveHost: async () => '93.184.216.34',
      fetcher: async () => { calls += 1; return mockResponse(pngBuffer(128)); },
    });
    const out = await cache.get('https://example.com/a.png');
    expect(out.contentType).toBe('image/png');
    expect(out.path).toMatch(/\.png$/);
    expect(calls).toBe(1);
    const bytes = await readFile(out.path);
    expect(bytes.byteLength).toBe(128);
  });

  it('returns the cached entry on a second request without re-fetching', async () => {
    let calls = 0;
    const cache = new ImageCache({
      cacheDir: dir,
      resolveHost: async () => '93.184.216.34',
      fetcher: async () => { calls += 1; return mockResponse(pngBuffer(32)); },
    });
    await cache.get('https://example.com/a.png');
    await cache.get('https://example.com/a.png');
    expect(calls).toBe(1);
  });

  it('rejects loopback and RFC1918 hostnames before fetching', async () => {
    const cache = new ImageCache({
      cacheDir: dir,
      // resolveHost should never be called for literal IPs that fail the
      // up-front guard; throw to make sure that's what happens.
      resolveHost: async () => { throw new Error('should not resolve'); },
      fetcher: async () => { throw new Error('should not fetch'); },
    });
    await expect(cache.get('http://127.0.0.1/x.png')).rejects.toBeInstanceOf(ImageCacheRejected);
    await expect(cache.get('http://10.0.0.5/x.png')).rejects.toBeInstanceOf(ImageCacheRejected);
    await expect(cache.get('http://192.168.1.10/x.png')).rejects.toBeInstanceOf(ImageCacheRejected);
  });

  it('rejects hostnames that resolve to private IPs (SSRF guard)', async () => {
    const cache = new ImageCache({
      cacheDir: dir,
      resolveHost: async () => '10.0.0.5',
      fetcher: async () => { throw new Error('should not fetch'); },
    });
    await expect(cache.get('https://attacker.example/x.png')).rejects.toMatchObject({ status: 403 });
  });

  it('rejects non-image content-types', async () => {
    const cache = new ImageCache({
      cacheDir: dir,
      resolveHost: async () => '93.184.216.34',
      fetcher: async () => new Response('hi', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    await expect(cache.get('https://example.com/x')).rejects.toMatchObject({ status: 415 });
  });

  it('rejects SVG (server-decided to avoid embedded scripts)', async () => {
    const cache = new ImageCache({
      cacheDir: dir,
      resolveHost: async () => '93.184.216.34',
      fetcher: async () => new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } }),
    });
    await expect(cache.get('https://example.com/x.svg')).rejects.toMatchObject({ status: 415 });
  });

  it('aborts streaming downloads that exceed the size cap', async () => {
    const huge = Buffer.alloc(6 * 1024 * 1024, 1); // 6 MB > 5 MB cap
    const cache = new ImageCache({
      cacheDir: dir,
      resolveHost: async () => '93.184.216.34',
      // Omit content-length so the streamed-size guard is what triggers.
      fetcher: async () => new Response(huge, { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    await expect(cache.get('https://example.com/big.png')).rejects.toMatchObject({ status: 413 });
    // Partial tmp file should be cleaned up.
    const remaining = await readdir(dir);
    expect(remaining.find((n) => n.endsWith('.tmp'))).toBeUndefined();
  });

  it('rejects unsupported URL schemes', async () => {
    const cache = new ImageCache({
      cacheDir: dir,
      resolveHost: async () => '93.184.216.34',
      fetcher: async () => { throw new Error('should not fetch'); },
    });
    await expect(cache.get('file:///etc/passwd')).rejects.toMatchObject({ status: 400 });
    await expect(cache.get('not a url')).rejects.toMatchObject({ status: 400 });
  });

  it('survives a stale meta file pointing at a deleted asset', async () => {
    // Pre-seed a meta file whose target file does not exist; cache must
    // re-fetch rather than returning a stale entry.
    const cache = new ImageCache({
      cacheDir: dir,
      resolveHost: async () => '93.184.216.34',
      fetcher: async () => mockResponse(pngBuffer(48)),
    });
    const url = 'https://example.com/c.png';
    const key = (await import('node:crypto')).createHash('sha256').update(url).digest('hex');
    await writeFile(path.join(dir, `${key}.json`), JSON.stringify({ path: path.join(dir, 'ghost.png'), contentType: 'image/png' }));
    const out = await cache.get(url);
    expect(out.path).not.toContain('ghost.png');
    const bytes = await readFile(out.path);
    expect(bytes.byteLength).toBe(48);
  });

  it('coalesces concurrent requests for the same URL into one fetch', async () => {
    let calls = 0;
    let resolveFetch!: () => void;
    const gate = new Promise<void>((r) => { resolveFetch = r; });
    const cache = new ImageCache({
      cacheDir: dir,
      resolveHost: async () => '93.184.216.34',
      fetcher: async () => { calls += 1; await gate; return mockResponse(pngBuffer(16)); },
    });
    const a = cache.get('https://example.com/d.png');
    const b = cache.get('https://example.com/d.png');
    resolveFetch();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});

describe('isPrivateAddress', () => {
  it.each([
    ['localhost', true],
    ['foo.localhost', true],
    ['127.0.0.1', true],
    ['10.0.0.1', true],
    ['172.16.5.7', true],
    ['172.31.255.1', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['100.64.0.1', true],
    ['169.254.169.254', true],
    ['224.0.0.1', true],
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['::1', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['2606:4700:4700::1111', false],
  ])('classifies %s correctly', (host, expected) => {
    expect(isPrivateAddress(host)).toBe(expected);
  });
});
