import { logger } from '../logger';
import { parsePairingUrl, pairWithPeer } from './peer-client';
import type { PeerStore } from './peer-store';

export interface PeerSummary {
  id: string;
  name: string;
  baseUrl: string;
  pairedAt: number;
  online: boolean;
}

const ONLINE_TIMEOUT_MS = 2000;

async function isOnline(baseUrl: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/sessions?limit=1`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(ONLINE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listPeers(store: PeerStore): Promise<PeerSummary[]> {
  return Promise.all(
    store.list().map(async (p) => {
      let online = false;
      try {
        online = await isOnline(p.baseUrl, store.token(p.id));
      } catch (err) {
        logger.warn(`peers: could not read token for ${p.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { id: p.id, name: p.name, baseUrl: p.baseUrl, pairedAt: p.pairedAt, online };
    }),
  );
}

/** Errors thrown here carry the user-facing copy. */
export async function addPeer(store: PeerStore, name: string, pairingUrl: string): Promise<{ id: string }> {
  const { baseUrl, code } = parsePairingUrl(pairingUrl);
  // Before pairing: a rejected name must not leave a paired device behind on the remote.
  // findByName also prefix-matches, so only an exact (case-insensitive) hit is a duplicate.
  const existing = store.findByName(name);
  if (existing && existing.name.toLowerCase() === name.toLowerCase()) throw duplicate(name);
  let paired: { token: string; deviceId: string };
  try {
    paired = await pairWithPeer(baseUrl, code);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (/\(401\)/.test(m)) throw new Error('That link has expired — make a new one on the other machine.');
    if (/^pair failed \(/.test(m)) throw new Error(m);
    throw new Error("Couldn't reach that machine.");
  }
  try {
    const peer = store.add({ name, baseUrl, deviceId: paired.deviceId, token: paired.token });
    return { id: peer.id };
  } catch (err) {
    if (/is already paired$/.test(err instanceof Error ? err.message : '')) {
      throw duplicate(name);
    }
    throw err;
  }
}

function duplicate(name: string): Error {
  return new Error(`You already have a machine called "${name}".`);
}
