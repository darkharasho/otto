#!/usr/bin/env node
// Reads public/svg/otto.svg, rasterizes to 1024px, then emits:
//   build/icon.png   (512x512, Linux)
//   build/icon.ico   (Windows multi-resolution)
//   build/icon.icns  (macOS)
// Run via `npm run icons`.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import png2icons from 'png2icons';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const srcSvg = join(repoRoot, 'public', 'svg', 'otto.svg');
const outDir = join(repoRoot, 'build');

async function main() {
  const svg = await readFile(srcSvg);
  await mkdir(outDir, { recursive: true });

  // 1024x1024 master PNG (in-memory) for ico/icns generation.
  const master = await sharp(svg, { density: 384 })
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Linux: 512x512 PNG
  await sharp(master).resize(512, 512).png().toFile(join(outDir, 'icon.png'));

  // Windows .ico (multi-size)
  const ico = png2icons.createICO(master, png2icons.BILINEAR, 0, false);
  if (!ico) throw new Error('createICO failed');
  await writeFile(join(outDir, 'icon.ico'), ico);

  // macOS .icns
  const icns = png2icons.createICNS(master, png2icons.BILINEAR, 0);
  if (!icns) throw new Error('createICNS failed');
  await writeFile(join(outDir, 'icon.icns'), icns);

  console.log('Wrote build/icon.{png,ico,icns}');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
