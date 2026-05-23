import path from 'node:path';

/**
 * Build the exact shell command the user (or a DE shortcut binding) should
 * invoke to toggle Otto. Detection logic, in priority order:
 *
 *   1. APPIMAGE env var — running from an AppImage; this points at the real
 *      .AppImage file on disk, which survives across squashfs remounts.
 *   2. process.execPath — for deb/rpm/tarball installs this is the Electron
 *      binary (e.g. /opt/Otto/otto).
 *
 * The dev command is independent: dev builds run through electron-vite, so
 * `process.execPath` is the Electron from node_modules — not something the
 * user can usefully bind to. Instead we point at `node out/main/index.js`
 * in the repo. The CLI fast-path in src/main/index.ts handles `toggle` before
 * Electron loads, so plain node is enough.
 */
export interface CommandInfo {
  prod: string;
  /** Present only when running from the dev build, so we know the repo root. */
  dev?: string;
}

export function buildToggleCommands(opts: {
  appImage?: string;
  execPath: string;
  isDevInstance: boolean;
  /** Repo root; defaults to process.cwd(). Only used for the dev command. */
  repoRoot?: string;
}): CommandInfo {
  const prodExec = opts.appImage && opts.appImage.length > 0 ? opts.appImage : opts.execPath;
  const prod = `${shQuote(prodExec)} toggle`;

  if (!opts.isDevInstance) {
    return { prod };
  }

  const root = opts.repoRoot ?? process.cwd();
  const devEntry = path.join(root, 'out', 'main', 'index.js');
  const dev = `node ${shQuote(devEntry)} toggle --dev`;
  return { prod, dev };
}

/**
 * Single-quote a shell argument. Existing single quotes are escaped by closing
 * the quote, emitting `\'`, and reopening — the classic POSIX idiom. Good for
 * paths with spaces or special characters.
 */
function shQuote(s: string): string {
  if (s.length === 0) return "''";
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
