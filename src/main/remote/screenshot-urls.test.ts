import { describe, it, expect } from 'vitest';
import { ScreenshotUrlSigner } from './screenshot-urls';

describe('ScreenshotUrlSigner', () => {
  const signer = new ScreenshotUrlSigner('test-secret', () => 1000);

  it('signs and verifies a fresh URL', () => {
    const url = signer.sign('abc');
    const { ok, id } = signer.verify(url);
    expect(ok).toBe(true);
    expect(id).toBe('abc');
  });

  it('rejects expired URLs', () => {
    const signer2 = new ScreenshotUrlSigner('test-secret', () => 1000);
    const url = signer2.sign('abc');
    const signer3 = new ScreenshotUrlSigner('test-secret', () => 1000 + 120_000);
    expect(signer3.verify(url).ok).toBe(false);
  });

  it('rejects tampered URLs', () => {
    const url = signer.sign('abc');
    const tampered = url.replace('id=abc', 'id=xyz');
    expect(signer.verify(tampered).ok).toBe(false);
  });

  it('single-use: second verify of same URL fails', () => {
    const url = signer.sign('abc');
    expect(signer.verify(url).ok).toBe(true);
    expect(signer.verify(url).ok).toBe(false);
  });
});
