import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FactRepo } from '../db/fact-repo';
import { logger } from '../logger';

const LEGACY_FILE = 'knowledge.md';
const BACKUP_FILE = 'knowledge.md.pre-split.bak';
const BULLET_RE = /^\s*-\s*\((\d{4})-(\d{2})-(\d{2})\)\s*(.*\S)\s*$/;

export async function importLegacyKnowledge(configDir: string, repo: FactRepo): Promise<void> {
  const src = path.join(configDir, LEGACY_FILE);
  let text: string;
  try {
    text = await fsp.readFile(src, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.toLowerCase().startsWith('durable facts')) continue;
    const m = BULLET_RE.exec(line);
    let body: string;
    let createdAt: number | undefined;
    if (m) {
      body = m[4]!;
      const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
      createdAt = Date.UTC(y, mo - 1, d);
    } else {
      body = line;
    }
    try {
      repo.upsert({ body, pinned: true, createdAt });
    } catch (err) {
      logger.warn(`importLegacyKnowledge skipped a line: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await fsp.rename(src, path.join(configDir, BACKUP_FILE));
}
