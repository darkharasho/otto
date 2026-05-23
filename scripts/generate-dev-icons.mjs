#!/usr/bin/env node
// Generates "-dev" variants of the app/tray icons by hue-shifting the
// indigo brand color to amber so dev and prod builds are visually distinct.
// Re-run when the prod icons change.
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sources = [
  { in: 'build/icon.png',                out: 'build/icon-dev.png' },
  { in: 'public/tray/tray-icon.png',     out: 'public/tray/tray-icon-dev.png',     badge: true,  badgeSize: 32 },
  { in: 'public/tray/tray-icon@2x.png',  out: 'public/tray/tray-icon-dev@2x.png',  badge: true,  badgeSize: 64 },
  { in: 'public/tray/tray-icon@3x.png',  out: 'public/tray/tray-icon-dev@3x.png',  badge: true,  badgeSize: 96 },
];

// Dev base is amber, so the prod amber badge would vanish. Use a red badge
// on dev so it stands out against the icon.
const DEV_BADGE = '#ef4444';

function badgeSvg(size) {
  const r = size / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<circle cx="${r}" cy="${r}" r="${r}" fill="${DEV_BADGE}"/>` +
    `</svg>`
  );
}

// Remap indigo (#7C7CFF-ish) to amber (#F59E0B) while preserving alpha.
// We do this with a per-pixel rewrite rather than hue-rotate so the result
// is a flat, recognizable color regardless of source saturation.
async function tint(srcPath, dstPath) {
  const img = sharp(srcPath).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue;
    // Source is a single-tone glyph — alpha already encodes the antialiasing,
    // so we just stamp a flat amber where the glyph exists.
    out[i]     = 245;
    out[i + 1] = 158;
    out[i + 2] = 11;
  }
  await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toFile(dstPath);
}

for (const { in: src, out: dst, badge, badgeSize } of sources) {
  const srcAbs = path.join(repoRoot, src);
  const dstAbs = path.join(repoRoot, dst);
  await tint(srcAbs, dstAbs);
  // eslint-disable-next-line no-console
  console.log(`wrote ${dst}`);

  if (badge) {
    // Composite a red dot in the top-right of the just-tinted dev icon to
    // produce the "-badge" variant used when a turn-complete notification is
    // pending.
    const dotPx = Math.max(6, Math.round(badgeSize * 0.4));
    const tintedBuf = await sharp(dstAbs).png().toBuffer();
    const badged = await sharp(tintedBuf)
      .composite([
        {
          input: await sharp(badgeSvg(dotPx)).png().toBuffer(),
          top: 0,
          left: badgeSize - dotPx,
        },
      ])
      .png()
      .toBuffer();
    const badgedDst = dst.replace(/\.png$/, '-badge.png');
    await sharp(badged).toFile(path.join(repoRoot, badgedDst));
    // eslint-disable-next-line no-console
    console.log(`wrote ${badgedDst}`);
  }
}
