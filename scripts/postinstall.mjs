#!/usr/bin/env node
// Replaces `electron-builder install-app-deps`, which walks the entire native
// dep tree and tries to rebuild usocket (POSIX-only) on Windows. We only need
// better-sqlite3 rebuilt for Electron's ABI — every other native dep we use
// ships prebuilts (sharp, onnxruntime-node) or is loaded as an extension
// (sqlite-vec). Pin the rebuild to that one module.

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const { rebuild } = require('@electron/rebuild');
const electronVersion = require(
  path.join(repoRoot, 'node_modules', 'electron', 'package.json')
).version;

await rebuild({
  buildPath: repoRoot,
  electronVersion,
  onlyModules: ['better-sqlite3'],
  force: true,
});

const r = spawnSync('node', ['scripts/fetch-embedding-model.mjs'], {
  stdio: 'inherit',
  cwd: repoRoot,
  shell: true,
});
process.exit(r.status ?? 1);
