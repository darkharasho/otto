import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import { logger } from '../logger';

export interface Peer {
  id: string;
  name: string;
  baseUrl: string;
  deviceId: string;
  pairedAt: number;
}

export interface TokenCipher {
  encrypt(s: string): { data: Buffer; encrypted: boolean };
  decrypt(data: Buffer, encrypted: boolean): string;
}

interface Row {
  id: string;
  name: string;
  base_url: string;
  token_enc: Buffer;
  token_is_encrypted: number;
  device_id: string;
  paired_at: number;
}

const toPeer = (r: Row): Peer => ({
  id: r.id,
  name: r.name,
  baseUrl: r.base_url,
  deviceId: r.device_id,
  pairedAt: r.paired_at,
});

export class PeerStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: TokenCipher,
    private readonly now: () => number = Date.now,
  ) {}

  add(p: { name: string; baseUrl: string; deviceId: string; token: string }): Peer {
    const id = randomUUID();
    const { data, encrypted } = this.cipher.encrypt(p.token);
    const pairedAt = this.now();
    try {
      this.db
        .prepare(
          `INSERT INTO peers (id, name, base_url, token_enc, token_is_encrypted, device_id, paired_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, p.name, p.baseUrl, data, encrypted ? 1 : 0, p.deviceId, pairedAt);
    } catch (e) {
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error(`A machine named "${p.name}" is already paired`);
      }
      throw e;
    }
    return { id, name: p.name, baseUrl: p.baseUrl, deviceId: p.deviceId, pairedAt };
  }

  list(): Peer[] {
    const rows = this.db.prepare('SELECT * FROM peers ORDER BY paired_at, name').all() as Row[];
    return rows.map(toPeer);
  }

  findByName(name: string): Peer | null {
    const q = name.toLowerCase();
    const peers = this.list();
    const exact = peers.find((p) => p.name.toLowerCase() === q);
    if (exact) return exact;
    const prefixed = peers.filter((p) => p.name.toLowerCase().startsWith(q));
    return prefixed.length === 1 ? prefixed[0]! : null;
  }

  token(id: string): string {
    const row = this.db.prepare('SELECT * FROM peers WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error(`Unknown peer: ${id}`);
    return this.cipher.decrypt(row.token_enc, row.token_is_encrypted === 1);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM peers WHERE id = ?').run(id);
  }
}

export function safeStorageCipher(): TokenCipher {
  let warned = false;
  return {
    encrypt(s) {
      if (safeStorage.isEncryptionAvailable()) {
        return { data: safeStorage.encryptString(s), encrypted: true };
      }
      if (!warned) {
        warned = true;
        logger.warn('safeStorage unavailable; storing peer tokens unencrypted');
      }
      return { data: Buffer.from(s, 'utf8'), encrypted: false };
    },
    decrypt(data, encrypted) {
      return encrypted ? safeStorage.decryptString(data) : data.toString('utf8');
    },
  };
}
