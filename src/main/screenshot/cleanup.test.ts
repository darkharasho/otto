import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepOrphanScreenshots, wipeAllScreenshots } from './cleanup';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'otto-cleanup-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('deletes session dirs not in the known set', async () => {
  mkdirSync(path.join(root, 's1')); writeFileSync(path.join(root, 's1', 'a.png'), 'x');
  mkdirSync(path.join(root, 's2')); writeFileSync(path.join(root, 's2', 'b.png'), 'x');
  await sweepOrphanScreenshots(root, new Set(['s1']));
  expect(readdirSync(root)).toEqual(['s1']);
});

it('keeps everything when all dirs are known', async () => {
  mkdirSync(path.join(root, 's1')); writeFileSync(path.join(root, 's1', 'a.png'), 'x');
  await sweepOrphanScreenshots(root, new Set(['s1']));
  expect(readdirSync(root)).toEqual(['s1']);
});

it('wipeAllScreenshots removes every session dir', async () => {
  mkdirSync(path.join(root, 's1')); writeFileSync(path.join(root, 's1', 'a.png'), 'x');
  mkdirSync(path.join(root, 's2'));
  await wipeAllScreenshots(root);
  expect(readdirSync(root)).toEqual([]);
});

it('no-op when root does not exist', async () => {
  await sweepOrphanScreenshots(path.join(root, 'nope'), new Set());
  await wipeAllScreenshots(path.join(root, 'nope'));
});
