import { promises as fsp } from 'node:fs';
import path from 'node:path';

export async function sweepOrphanSessionFiles(root: string, knownSessionIds: ReadonlySet<string>): Promise<void> {
  let entries: string[];
  try { entries = await fsp.readdir(root); } catch { return; }
  await Promise.all(entries.map(async (name) => {
    if (knownSessionIds.has(name)) return;
    await fsp.rm(path.join(root, name), { recursive: true, force: true });
  }));
}

export async function wipeAllSessionFiles(root: string): Promise<void> {
  let entries: string[];
  try { entries = await fsp.readdir(root); } catch { return; }
  await Promise.all(entries.map((name) =>
    fsp.rm(path.join(root, name), { recursive: true, force: true })
  ));
}
