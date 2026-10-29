#!/usr/bin/env node
// Builds usocket (dbus-next's optional native dep) for Electron's ABI on Linux.
// Without it dbus-next silently falls back to a plain net socket that cannot
// pass file descriptors, and Otto's fast KWin ScreenShot2 capture path (which
// hands KWin a pipe fd) is unavailable — screenshots then fall back to
// spawning Spectacle (~1s each instead of ~0.1s). Best-effort: a failed build
// only loses the fast path, so this never fails the caller.
//
// usocket is POSIX-only and unused off Linux, so other platforms skip it.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, realpathSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findUsocketDir() {
  // pnpm keeps transitive deps under node_modules/.pnpm/<name>@<ver>/node_modules/<name>.
  const store = path.join(repoRoot, 'node_modules', '.pnpm');
  if (!existsSync(store)) return null;
  const entry = readdirSync(store).find((d) => d.startsWith('usocket@'));
  if (!entry) return null;
  const dir = path.join(store, entry, 'node_modules', 'usocket');
  return existsSync(dir) ? realpathSync(dir) : null;
}

function findNodeGyp() {
  const require = createRequire(path.join(repoRoot, 'package.json'));
  try {
    return require.resolve('node-gyp/bin/node-gyp.js');
  } catch {
    const store = path.join(repoRoot, 'node_modules', '.pnpm');
    const entry = readdirSync(store)
      .filter((d) => d.startsWith('node-gyp@'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    if (!entry) return null;
    const p = path.join(store, entry, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
    return existsSync(p) ? p : null;
  }
}

export function buildUsocketForElectron() {
  if (process.platform !== 'linux') return true;
  const dir = findUsocketDir();
  const gyp = findNodeGyp();
  if (!dir || !gyp) {
    console.warn('[build-usocket] usocket or node-gyp not found; fast KWin capture disabled');
    return false;
  }
  const require = createRequire(import.meta.url);
  const electronVersion = require(path.join(repoRoot, 'node_modules', 'electron', 'package.json')).version;
  const r = spawnSync(
    process.execPath,
    [gyp, 'rebuild', `--target=${electronVersion}`, '--dist-url=https://electronjs.org/headers'],
    { cwd: dir, stdio: 'inherit' }
  );
  const ok = r.status === 0 && existsSync(path.join(dir, 'build', 'Release', 'uwrap.node'));
  if (!ok) console.warn('[build-usocket] usocket build failed; fast KWin capture disabled');
  return ok;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildUsocketForElectron();
}
