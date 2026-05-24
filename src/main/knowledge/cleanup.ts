import type { Database } from 'better-sqlite3';
import type { FactRepo } from '../db/fact-repo';
import { normalizeFactLine } from './dedup';
import { logger } from '../logger';

const HTML_COMMENT_RE = /^\s*<!--|-->\s*$/;
const BULLET_PREFIX_RE = /^(?:\s*-\s+)+/;

/**
 * One-shot repair for the dashed-duplicate accumulation bug. A feedback loop
 * between `regenerateKnowledgeFile` and `importLegacyKnowledge` was storing
 * each fact again every startup with another leading "- " prepended, and was
 * storing the file's HTML auto-generated header as a fact body.
 */
export function cleanupDuplicateFacts(
  db: Database,
  repo: FactRepo
): { deleted: number; rewritten: number } {
  const rows = db
    .prepare('SELECT id, body, body_norm, use_count FROM fact')
    .all() as Array<{ id: string; body: string; body_norm: string; use_count: number }>;

  let deleted = 0;
  let rewritten = 0;

  const updateStmt = db.prepare('UPDATE fact SET body = ?, body_norm = ? WHERE id = ?');
  const collisionStmt = db.prepare('SELECT id, use_count FROM fact WHERE body_norm = ? AND id != ?');

  for (const r of rows) {
    if (HTML_COMMENT_RE.test(r.body)) {
      repo.delete(r.id);
      deleted += 1;
      continue;
    }
    const newNorm = normalizeFactLine(r.body);
    if (newNorm === r.body_norm) continue;
    if (!newNorm) {
      repo.delete(r.id);
      deleted += 1;
      continue;
    }
    const collision = collisionStmt.get(newNorm, r.id) as
      | { id: string; use_count: number }
      | undefined;
    if (collision) {
      // Keep whichever row has the higher use_count — usually the un-dashed
      // original, but handle the reverse case for safety.
      const loser = collision.use_count >= r.use_count ? r.id : collision.id;
      repo.delete(loser);
      deleted += 1;
    } else {
      const cleanBody = r.body.replace(BULLET_PREFIX_RE, '').trim();
      updateStmt.run(cleanBody, newNorm, r.id);
      rewritten += 1;
    }
  }

  if (deleted || rewritten) {
    logger.info(`cleanupDuplicateFacts: deleted=${deleted} rewritten=${rewritten}`);
  }
  return { deleted, rewritten };
}
