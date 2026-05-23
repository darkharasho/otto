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
const BADGE = '#f59e0b'; // amber-500
// Linux/Wayland tray usually wants 22-32px; macOS template needs @2x; Windows
// can take 16/32. Emit a small set and let the platform layer pick.
const SIZES = [
  { base: 'tray-icon', size: 32 },
  { base: 'tray-icon@2x', size: 64 },
  { base: 'tray-icon@3x', size: 96 },
];

/** Build a circular badge SVG at the requested pixel size. */
function badgeSvg(size) {
  const r = size / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<circle cx="${r}" cy="${r}" r="${r}" fill="${BADGE}"/>` +
    `</svg>`
  );
}

async function main() {
  const raw = await readFile(srcSvg, 'utf8');
  const tinted = raw.replace(/fill:#000000/g, `fill:${ACCENT}`);
  await mkdir(outDir, { recursive: true });

  for (const { base, size } of SIZES) {
    const iconBuf = await sharp(Buffer.from(tinted), { density: 1024 })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const plainName = `${base}.png`;
    await writeFile(join(outDir, plainName), iconBuf);
    // eslint-disable-next-line no-console
    console.log(`wrote ${join(outDir, plainName)} (${size}×${size})`);

    // Badged variant: composite an amber dot in the top-right corner. Dot
    // diameter is ~40% of the icon so it's legible at 16/22px tray sizes.
    const badgeSize = Math.max(6, Math.round(size * 0.4));
    const badgedBuf = await sharp(iconBuf)
      .composite([
        {
          input: await sharp(badgeSvg(badgeSize)).png().toBuffer(),
          top: 0,
          left: size - badgeSize,
        },
      ])
      .png()
      .toBuffer();
    const badgedName = `${base}-badge.png`;
    await writeFile(join(outDir, badgedName), badgedBuf);
    // eslint-disable-next-line no-console
    console.log(`wrote ${join(outDir, badgedName)} (${size}×${size}, with badge)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
