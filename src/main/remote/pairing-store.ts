import type { Database } from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';

export interface PairedDevice {
  id: string;
  label: string;
  pairedAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

interface Row {
  id: string;
  label: string;
  token_hash: string;
  paired_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

export class PairingStore {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}

  async issue(label: string): Promise<{ deviceId: string; token: string }> {
    const deviceId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = await argon2.hash(token, { type: argon2.argon2id });
    this.db.prepare(
      `INSERT INTO paired_devices (id, label, token_hash, paired_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL, NULL)`
    ).run(deviceId, label, tokenHash, this.now());
    return { deviceId, token };
  }

  async verify(token: string): Promise<PairedDevice | null> {
    const rows = this.db.prepare(
      `SELECT * FROM paired_devices WHERE revoked_at IS NULL`
    ).all() as Row[];
    for (const row of rows) {
      if (await argon2.verify(row.token_hash, token)) {
        const now = this.now();
        this.db.prepare(`UPDATE paired_devices SET last_seen_at = ? WHERE id = ?`).run(now, row.id);
        return { id: row.id, label: row.label, pairedAt: row.paired_at, lastSeenAt: now, revokedAt: null };
      }
    }
    return null;
  }

  revoke(deviceId: string): void {
    this.db.prepare(`UPDATE paired_devices SET revoked_at = ? WHERE id = ?`).run(this.now(), deviceId);
  }

  list(): PairedDevice[] {
    const rows = this.db.prepare(`SELECT * FROM paired_devices ORDER BY paired_at DESC`).all() as Row[];
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      pairedAt: r.paired_at,
      lastSeenAt: r.last_seen_at,
      revokedAt: r.revoked_at,
    }));
  }
}
