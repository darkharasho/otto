// Subset of shared/messages.ts — only the types needed by the mobile app.

export type ActionClass = 'read' | 'reversible' | 'destructive' | 'irreversible';

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export function extFromMime(m: ImageMimeType): 'png' | 'jpg' | 'webp' | 'gif' {
  switch (m) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
  }
}

export interface ImageRef {
  type: 'image-ref';
  id: string;
  sessionId: string;
  path: string;
  width: number;
  height: number;
  mimeType: ImageMimeType;
  source: 'screenshot' | 'user';
}
