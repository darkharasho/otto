#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

// `usocket` (transitive of dbus-next, our Linux-only XDG portal client) is
// POSIX-only and fails to compile on Windows. Skip it by rebuilding only the
// native modules Windows actually uses; on Linux/mac let the full rebuild run.
const args = ['electron-rebuild'];
if (isWindows) args.push('--only', 'better-sqlite3');

let r = spawnSync('pnpm', ['exec', ...args], { stdio: 'inherit', shell: true });
if (r.status !== 0) process.exit(r.status);

r = spawnSync('node', ['scripts/fetch-embedding-model.mjs'], {
  stdio: 'inherit',
  shell: true,
});
process.exit(r.status ?? 1);
