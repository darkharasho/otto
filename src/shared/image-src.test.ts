import { describe, it, expect } from 'vitest';
import { toLocalImageSrc } from './image-src';

describe('toLocalImageSrc', () => {
  it('rewrites http(s) URLs to otto-img:// in the electron context', () => {
    const out = toLocalImageSrc('https://example.com/a.png', { kind: 'electron' });
    expect(out).toMatch(/^otto-img:\/\/\/\?u=/);
  });

  it('rewrites to the bridge /image endpoint in the remote context', () => {
    const out = toLocalImageSrc('https://example.com/a.png', { kind: 'remote', token: 'tok-1' });
    expect(out).toMatch(/^\/image\?u=[A-Za-z0-9_-]+&token=tok-1$/);
  });

  it('honors a basePath for remote contexts on a different origin', () => {
    const out = toLocalImageSrc('https://example.com/a.png', { kind: 'remote', token: 't', basePath: 'http://otto.tail/x' });
    expect(out).toMatch(/^http:\/\/otto\.tail\/x\/image\?/);
  });

  it('passes through data: URLs unchanged', () => {
    const data = 'data:image/png;base64,iVBORw0KGgo=';
    expect(toLocalImageSrc(data, { kind: 'electron' })).toBe(data);
    expect(toLocalImageSrc(data, { kind: 'remote', token: 't' })).toBe(data);
  });

  it('rejects unsupported schemes', () => {
    expect(toLocalImageSrc('file:///etc/passwd', { kind: 'electron' })).toBeNull();
    expect(toLocalImageSrc('javascript:alert(1)', { kind: 'electron' })).toBeNull();
    expect(toLocalImageSrc('about:blank', { kind: 'electron' })).toBeNull();
  });

  it('rejects empty, missing, and absurdly long URLs', () => {
    expect(toLocalImageSrc(undefined, { kind: 'electron' })).toBeNull();
    expect(toLocalImageSrc('', { kind: 'electron' })).toBeNull();
    expect(toLocalImageSrc('   ', { kind: 'electron' })).toBeNull();
    expect(toLocalImageSrc(`https://x/${'a'.repeat(5000)}`, { kind: 'electron' })).toBeNull();
  });

  it('round-trips the original URL via base64url encoding', () => {
    const original = 'https://example.com/path with spaces/é.png?x=1';
    const out = toLocalImageSrc(original, { kind: 'electron' })!;
    const encoded = new URL(out).searchParams.get('u')!;
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    expect(decoded).toBe(original);
  });
});
