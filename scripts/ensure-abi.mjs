#!/usr/bin/env node
// Ensures better-sqlite3 is compiled for the requested ABI (node or electron).
// Tracks the last build target in .abi-state so we skip the slow rebuild when
// the binary is already correct. Invoked from npm pre-hooks.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (target !== 'node' && target !== 'electron') {
  console.error('usage: ensure-abi.mjs <node|electron>');
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = path.join(repoRoot, 'node_modules', '.otto-abi-state');
const binary = path.join(repoRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

const current = existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : '';

if (current === target && existsSync(binary)) {
  process.exit(0);
}

console.log(`[ensure-abi] rebuilding better-sqlite3 for ${target}…`);
try {
  if (target === 'electron') {
    execSync('npx --no-install @electron/rebuild -f -w better-sqlite3', {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  } else {
    execSync('npm rebuild better-sqlite3', { cwd: repoRoot, stdio: 'inherit' });
  }
  writeFileSync(stateFile, target);
} catch (err) {
  console.error(`[ensure-abi] rebuild failed: ${err.message}`);
  process.exit(1);
}
