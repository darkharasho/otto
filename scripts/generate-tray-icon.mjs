#!/usr/bin/env node
// One-shot generator for the system-tray PNG. Reads public/svg/otto.svg,
// recolors the path fill to the accent color, and rasterizes at the sizes
// Linux/macOS/Windows trays expect. Run via `node scripts/generate-tray-icon.mjs`.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const srcSvg = join(repoRoot, 'public', 'svg', 'otto.svg');
const outDir = join(repoRoot, 'public', 'tray');

const ACCENT = '#7c7dff';
// Linux/Wayland tray usually wants 22-32px; macOS template needs @2x; Windows
// can take 16/32. Emit a small set and let the platform layer pick.
const SIZES = [
  { name: 'tray-icon.png', size: 32 },
  { name: 'tray-icon@2x.png', size: 64 },
  { name: 'tray-icon@3x.png', size: 96 },
];

async function main() {
  const raw = await readFile(srcSvg, 'utf8');
  const tinted = raw.replace(/fill:#000000/g, `fill:${ACCENT}`);
  await mkdir(outDir, { recursive: true });

  for (const { name, size } of SIZES) {
    const png = await sharp(Buffer.from(tinted), { density: 1024 })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    await writeFile(join(outDir, name), png);
    // eslint-disable-next-line no-console
    console.log(`wrote ${join(outDir, name)} (${size}×${size})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
