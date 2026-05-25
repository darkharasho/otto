import { describe, it, expect } from 'vitest';
import { resolveTailnetIp, resolveTailnetEndpoint } from './tailnet';

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

describe('resolveTailnetEndpoint', () => {
  it('returns ip + composed host from MagicDNSSuffix', async () => {
    const ep = await resolveTailnetEndpoint({
      exec: async () => ({ stdout: JSON.stringify({
        MagicDNSSuffix: 'tail-scale.ts.net',
        Self: { HostName: 'otto', TailscaleIPs: ['100.64.1.2'] },
      }), stderr: '', code: 0 }),
    });
    expect(ep).toEqual({ ip: '100.64.1.2', host: 'otto.tail-scale.ts.net' });
  });

  it('falls back to Self.DNSName when MagicDNSSuffix missing, strips trailing dot', async () => {
    const ep = await resolveTailnetEndpoint({
      exec: async () => ({ stdout: JSON.stringify({
        Self: { HostName: 'otto', DNSName: 'otto.tail-scale.ts.net.', TailscaleIPs: ['100.64.1.2'] },
      }), stderr: '', code: 0 }),
    });
    expect(ep.host).toBe('otto.tail-scale.ts.net');
  });

  it('returns ip-only when no MagicDNS data is present', async () => {
    const ep = await resolveTailnetEndpoint({
      exec: async () => ({ stdout: JSON.stringify({ Self: { TailscaleIPs: ['100.64.1.2'] } }), stderr: '', code: 0 }),
    });
    expect(ep).toEqual({ ip: '100.64.1.2', host: null });
  });

  it('returns nulls on tailscale failure', async () => {
    const ep = await resolveTailnetEndpoint({ exec: async () => ({ stdout: '', stderr: '', code: 1 }) });
    expect(ep).toEqual({ ip: null, host: null });
  });
});
