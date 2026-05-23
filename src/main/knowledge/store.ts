import { promises as fsp } from 'node:fs';
import path from 'node:path';

const FILENAME = 'knowledge.md';
const HEADER = '# Otto knowledge file\n\nDurable facts and preferences Otto has learned about this machine and its user. Edit freely; Otto reads this at the start of every turn and may append to it.\n\n';

function knowledgePath(configDir: string): string {
  return path.join(configDir, FILENAME);
}

export async function readKnowledge(configDir: string): Promise<string> {
  try {
    return await fsp.readFile(knowledgePath(configDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export async function appendKnowledge(configDir: string, note: string): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed) return;
  const file = knowledgePath(configDir);
  const existing = await readKnowledge(configDir);
  const prefix = existing.length === 0 ? HEADER : existing.endsWith('\n') ? existing : `${existing}\n`;
  const stamp = new Date().toISOString().slice(0, 10);
  await fsp.writeFile(file, `${prefix}- (${stamp}) ${trimmed}\n`, 'utf8');
}
