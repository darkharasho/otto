#!/usr/bin/env node
/**
 * Ad-hoc sign the dev Electron.app so macOS recognises it for Accessibility
 * permissions. Without a signature, the binary can't be added to
 * System Settings > Privacy & Security > Accessibility, which blocks the
 * native CGEvent tap hotkey.
 *
 * Only runs on macOS; silently skips on other platforms.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Resolve through the symlink so it works with both npm and pnpm store layouts.
import { realpathSync } from 'node:fs';
let electronApp = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
try { electronApp = realpathSync(path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app')); } catch {}

if (!existsSync(electronApp)) {
  console.log('[codesign-dev] Electron.app not found, skipping');
  process.exit(0);
}

try {
  // Strip extended attributes that block codesign (quarantine flags, etc.)
  execFileSync('xattr', ['-cr', electronApp], { stdio: 'ignore' });
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', electronApp], {
    stdio: 'ignore',
  });
  console.log('[codesign-dev] ad-hoc signed Electron.app for Accessibility');
} catch (err) {
  // Non-fatal — globalShortcut fallback still works.
  console.warn(`[codesign-dev] signing failed: ${err.message}`);
}
