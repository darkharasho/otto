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

const BRAND_PURPLE = '#7c7dff';

async function main() {
  const rawSvg = await readFile(srcSvg, 'utf8');
  // Brand-tinted SVG drives every output: app icons (so the OS launcher shows
  // Otto's purple identity) and the README header logo. The icon pipeline
  // doesn't need a separate untinted variant.
  const brandedSvg = Buffer.from(rawSvg.replace(/fill:#000000/g, `fill:${BRAND_PURPLE}`), 'utf8');

  await mkdir(outDir, { recursive: true });

  // 1024x1024 master PNG (in-memory) for ico/icns generation.
  const master = await sharp(brandedSvg, { density: 384 })
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

  // README header: 256x256 PNG under public/img/ (same brand-tinted source).
  const readmeOutDir = join(repoRoot, 'public', 'img');
  await mkdir(readmeOutDir, { recursive: true });
  await sharp(master).resize(256, 256).png().toFile(join(readmeOutDir, 'otto-logo.png'));

  // PWA / iOS home-screen icon: 512x512 with the brand mark inset on Otto's
  // dark surface so iOS's rounded-corner mask doesn't clip the glyph and the
  // icon has the same safe-area padding Apple's HIG expects (~12%).
  const PWA_SIZE = 512;
  const PWA_INSET = Math.round(PWA_SIZE * 0.76); // ~12% padding on each side
  const inner = await sharp(master)
    .resize(PWA_INSET, PWA_INSET, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const pwaIcon = await sharp({
    create: {
      width: PWA_SIZE,
      height: PWA_SIZE,
      channels: 4,
      // Matches manifest theme/background_color (#0d0d0e).
      background: { r: 0x0d, g: 0x0d, b: 0x0e, alpha: 1 },
    },
  })
    .composite([{ input: inner, gravity: 'center' }])
    .png()
    .toBuffer();
  await writeFile(join(repoRoot, 'src', 'renderer-remote', 'otto-logo.png'), pwaIcon);

  console.log('Wrote build/icon.{png,ico,icns}, public/img/otto-logo.png, and src/renderer-remote/otto-logo.png');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
