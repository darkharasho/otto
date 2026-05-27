import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeImage } from 'electron';
import type { ContentBlock } from '@shared/messages';
import { extFromMime, type ImageMimeType } from '@shared/messages';

// Re-export so tests have a stable import surface without reaching into @shared.
export const extOf = extFromMime;

export async function saveUserUpload(
  bytes: Buffer,
  mimeType: ImageMimeType,
  sessionId: string,
  configDir: string,
): Promise<Extract<ContentBlock, { type: 'image-ref' }>> {
  const dir = path.join(configDir, 'user-uploads', sessionId);
  await fsp.mkdir(dir, { recursive: true });
  const id = randomUUID();
  const file = path.join(dir, `${id}.${extFromMime(mimeType)}`);
  await fsp.writeFile(file, bytes);
  const img = nativeImage.createFromBuffer(bytes);
  const size = img.getSize();
  return {
    type: 'image-ref',
    id,
    sessionId,
    path: file,
    width: size.width,
    height: size.height,
    mimeType,
    source: 'user',
  };
}
