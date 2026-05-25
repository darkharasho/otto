import { describe, it, expect } from 'vitest';
import { resolveTailnetIp } from './tailnet';

describe('resolveTailnetIp', () => {
  it('returns the IPv4 from a successful exec', async () => {
    const ip = await resolveTailnetIp({ exec: async () => ({ stdout: '100.64.1.2\n', stderr: '', code: 0 }) });
    expect(ip).toBe('100.64.1.2');
  });

  it('returns null when tailscale is not installed', async () => {
    const ip = await resolveTailnetIp({
      exec: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    });
    expect(ip).toBeNull();
  });

  it('returns null when exit code is non-zero', async () => {
    const ip = await resolveTailnetIp({ exec: async () => ({ stdout: '', stderr: 'not running', code: 1 }) });
    expect(ip).toBeNull();
  });

  it('rejects non-IPv4 output', async () => {
    const ip = await resolveTailnetIp({ exec: async () => ({ stdout: 'fd7a::1\n', stderr: '', code: 0 }) });
    expect(ip).toBeNull();
  });
});
