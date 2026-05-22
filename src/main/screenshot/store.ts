import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function save(
  bytes: Buffer,
  sessionId: string,
  configDir: string
): Promise<string> {
  const dir = path.join(configDir, 'screenshots', sessionId);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.png`);
  await fsp.writeFile(file, bytes);
  return file;
}
