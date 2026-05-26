import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { protocol, net } from 'electron';

export type ResolveResult =
  | { ok: true; absPath: string }
  | { ok: false; status: 404 };

const SAFE_SESSION = /^[A-Za-z0-9_-]+$/;
const SAFE_FILE = /^[A-Za-z0-9_-]+\.png$/;

export function resolveImageRequest(rawUrl: string, root: string): ResolveResult {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { ok: false, status: 404 }; }
  const sessionId = url.hostname;
  const file = url.pathname.replace(/^\//, '');
  if (!SAFE_SESSION.test(sessionId)) return { ok: false, status: 404 };
  if (!SAFE_FILE.test(file)) return { ok: false, status: 404 };
  const abs = path.join(root, sessionId, file);
  if (!existsSync(abs)) return { ok: false, status: 404 };
  let real: string;
  try { real = realpathSync(abs); } catch { return { ok: false, status: 404 }; }
  const rootReal = realpathSync(root);
  if (!real.startsWith(rootReal + path.sep)) return { ok: false, status: 404 };
  return { ok: true, absPath: real };
}

export function registerOttoImageSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'otto-image', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export function registerOttoImageProtocol(root: string): void {
  protocol.handle('otto-image', (req) => {
    const r = resolveImageRequest(req.url, root);
    if (!r.ok) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(r.absPath).toString());
  });
}
