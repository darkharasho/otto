import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PeerStore } from './peer-store';
import { listPeers, addPeer } from './peer-admin';

vi.mock('../logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const peer = (id: string) => ({ id, name: `n${id}`, baseUrl: `http://h${id}:17829`, deviceId: 'd', pairedAt: 1 });

afterEach(() => vi.unstubAllGlobals());

describe('listPeers', () => {
  it('checks /sessions?limit=1 with the bearer token', async () => {
    const f = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', f);
    const store = { list: () => [peer('1')], token: () => 'tok' } as unknown as PeerStore;
    const out = await listPeers(store);
    expect(out).toEqual([{ id: '1', name: 'n1', baseUrl: 'http://h1:17829', pairedAt: 1, online: true }]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://h1:17829/sessions?limit=1');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('reports offline on network failure or non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { if (u.includes('h1')) throw new Error('x'); return { ok: false }; }));
    const store = { list: () => [peer('1'), peer('2')], token: () => 'tok' } as unknown as PeerStore;
    expect((await listPeers(store)).map((p) => p.online)).toEqual([false, false]);
  });

  it('reports a peer offline when its token cannot be decrypted, without failing the list', async () => {
    const f = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', f);
    const store = {
      list: () => [peer('1'), peer('2')],
      token: (id: string) => { if (id === '1') throw new Error('decrypt'); return 'tok'; },
    } as unknown as PeerStore;
    expect((await listPeers(store)).map((p) => p.online)).toEqual([false, true]);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('addPeer', () => {
  const link = 'http://desk:17829/pair?code=abc';
  const storeWith = (add: PeerStore['add']) => ({ add }) as unknown as PeerStore;

  it('pairs and stores the peer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ token: 't', deviceId: 'dev' }) })));
    const add = vi.fn(() => ({ id: 'new' }) as ReturnType<PeerStore['add']>);
    expect(await addPeer(storeWith(add), 'Desk', link)).toEqual({ id: 'new' });
    expect(add).toHaveBeenCalledWith({ name: 'Desk', baseUrl: 'http://desk:17829', deviceId: 'dev', token: 't' });
  });

  it('maps 401 to the expired-link copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, statusText: 'x', text: async () => 'bad' })));
    await expect(addPeer(storeWith(vi.fn()), 'Desk', link)).rejects.toThrow('That link has expired — make a new one on the other machine.');
  });

  it('maps a network failure to the unreachable copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(addPeer(storeWith(vi.fn()), 'Desk', link)).rejects.toThrow("Couldn't reach that machine.");
  });

  it('maps a duplicate name to the duplicate copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ token: 't', deviceId: 'dev' }) })));
    const add = vi.fn(() => { throw new Error('A machine named "Desk" is already paired'); });
    await expect(addPeer(storeWith(add as unknown as PeerStore['add']), 'Desk', link)).rejects.toThrow('You already have a machine called "Desk".');
  });
});
