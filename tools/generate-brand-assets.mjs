#!/usr/bin/env node
/**
 * Regenerate every Fliks brand asset (app icons, favicons, launcher icons,
 * splash screens, menu-bar icon) from the two source SVGs.
 *
 * Sources (tracked, the two artwork files provided by design):
 *   client/public/fliks-icon.svg   the standalone mark
 *   client/public/fliks-logo.svg   the mark + "Fliks" wordmark
 * Derived automatically:
 *   client/public/fliks-logo-ondark.svg  wordmark with white text (dark UI)
 *
 * Run:  cd tools && npm install && npm run generate
 * (only dependency is `sharp`; ICO/ICNS containers are assembled in-process)
 *
 * Conventions baked in here:
 *   - brand base #1d232a (manifest theme, Android adaptive bg, maskable bg)
 *   - opaque icons are flattened with NO alpha channel (App Store + webOS store
 *     reject alpha; webOS also needs the bg to match the appinfo tile colour)
 *   - transparent contexts (PWA "any", launcher foreground, Tizen) keep alpha
 *   - safe zones: adaptive foreground inside the 66% circle, maskable inside
 *     the 80% circle, app icons ~14% padding
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(REPO, 'client/public');
const DARK = { r: 29, g: 35, b: 42, alpha: 1 }; // #1d232a
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

const iconSvg = readFileSync(join(PUBLIC, 'fliks-icon.svg'));
const wordSvg = readFileSync(join(PUBLIC, 'fliks-logo.svg'));
// On-dark wordmark: the source navy text (#252a57/58) → white for dark UI.
const wordOnDark = wordSvg
  .toString('utf8')
  .replace(/#252a5[78]/gi, '#ffffff');
writeFileSync(join(PUBLIC, 'fliks-logo-ondark.svg'), wordOnDark);

const out = (p) => {
  const abs = join(REPO, p);
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
};
const write = async (buf, p) => {
  writeFileSync(out(p), buf);
  console.log('  ' + p);
};

/** Mark centered on a square `size` canvas. `bg=null` → transparent;
 *  otherwise flatten (no alpha). `pad` = fraction of margin on each side. */
async function icon(svg, size, { bg = null, pad = 0.04 } = {}) {
  const inner = Math.max(1, Math.round(size * (1 - pad * 2)));
  const logo = await sharp(svg, { density: 900 })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  let img = sharp({ create: { width: size, height: size, channels: 4, background: bg || { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: logo, gravity: 'center' }]);
  if (bg) img = img.flatten({ background: bg }).removeAlpha();
  return img.png().toBuffer();
}

/** Logo contained in `frac` of the short side, centered on a W×H bg. */
async function splash(svg, w, h, frac) {
  const box = Math.round(Math.min(w, h) * frac);
  const logo = await sharp(svg, { density: 900 })
    .resize(box, box, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp({ create: { width: w, height: h, channels: 4, background: DARK } })
    .composite([{ input: logo, gravity: 'center' }])
    .flatten({ background: DARK })
    .removeAlpha()
    .png()
    .toBuffer();
}

function buildIco(items) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(items.length, 4);
  const dir = Buffer.alloc(16 * items.length);
  let offset = 6 + 16 * items.length;
  items.forEach((it, i) => {
    const b = i * 16;
    dir.writeUInt8(it.size >= 256 ? 0 : it.size, b);
    dir.writeUInt8(it.size >= 256 ? 0 : it.size, b + 1);
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(it.buf.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += it.buf.length;
  });
  return Buffer.concat([header, dir, ...items.map((i) => i.buf)]);
}

function buildIcns(entries) {
  const body = Buffer.concat(
    entries.flatMap(({ type, buf }) => {
      const head = Buffer.alloc(8);
      head.write(type, 0, 'ascii');
      head.writeUInt32BE(buf.length + 8, 4);
      return [head, buf];
    }),
  );
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

const PWA_ROOTS = [
  'client/public',
  'client/ios/App/App/public',
  'client/android/app/src/main/assets/public',
];
const AND_RES = 'client/android/app/src/main/res';
const LAUNCH = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FG = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const IOS_SIZES = [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180, 1024];
const AND_SPLASH = {
  'drawable-land-hdpi': [800, 480], 'drawable-land-mdpi': [480, 320],
  'drawable-land-xhdpi': [1280, 720], 'drawable-land-xxhdpi': [1600, 960],
  'drawable-land-xxxhdpi': [1920, 1280], 'drawable-port-hdpi': [480, 800],
  'drawable-port-mdpi': [320, 480], 'drawable-port-xhdpi': [720, 1280],
  'drawable-port-xxhdpi': [960, 1600], 'drawable-port-xxxhdpi': [1280, 1920],
  drawable: [480, 320],
};

console.log('Generating brand assets…');
for (const root of PWA_ROOTS) {
  await write(await icon(iconSvg, 192, { pad: 0.04 }), `${root}/icons/icon-192x192.png`);
  await write(await icon(iconSvg, 512, { pad: 0.04 }), `${root}/icons/icon-512x512.png`);
  await write(await icon(iconSvg, 192, { bg: DARK, pad: 0.24 }), `${root}/icons/icon-192x192-maskable.png`);
  await write(await icon(iconSvg, 512, { bg: DARK, pad: 0.24 }), `${root}/icons/icon-512x512-maskable.png`);
  await write(await icon(iconSvg, 16, { pad: 0.02 }), `${root}/favicon-16.png`);
  await write(await icon(iconSvg, 32, { pad: 0.02 }), `${root}/favicon-32.png`);
  await write(await icon(iconSvg, 180, { bg: DARK, pad: 0.14 }), `${root}/apple-touch-icon.png`);
  const ico = buildIco([
    { size: 16, buf: await icon(iconSvg, 16, { pad: 0.02 }) },
    { size: 32, buf: await icon(iconSvg, 32, { pad: 0.02 }) },
    { size: 48, buf: await icon(iconSvg, 48, { pad: 0.02 }) },
  ]);
  await write(ico, `${root}/favicon.ico`);
}

// iOS app icon (single 1024, opaque)
await write(await icon(iconSvg, 1024, { bg: DARK, pad: 0.14 }), 'client/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
// logos/ios reference set (gitignored, kept for archival / manual Xcode use)
for (const s of IOS_SIZES) await write(await icon(iconSvg, s, { bg: DARK, pad: 0.14 }), `logos/ios/Icon-${s}.png`);
await write(await icon(iconSvg, 1024, { bg: DARK, pad: 0.14 }), 'logos/ios/Icon-1024-appstore-dark.png');
await write(await icon(iconSvg, 1024, { bg: WHITE, pad: 0.14 }), 'logos/ios/Icon-1024-appstore-light.png');

// Android adaptive + legacy launcher + in-app drawable
for (const [d, s] of Object.entries(LAUNCH)) {
  await write(await icon(iconSvg, s, { bg: DARK, pad: 0.14 }), `${AND_RES}/mipmap-${d}/ic_launcher.png`);
  await write(await icon(iconSvg, s, { bg: DARK, pad: 0.18 }), `${AND_RES}/mipmap-${d}/ic_launcher_round.png`);
}
for (const [d, s] of Object.entries(FG)) {
  await write(await icon(iconSvg, s, { pad: 0.28 }), `${AND_RES}/mipmap-${d}/ic_launcher_foreground.png`); // 66% safe circle
}
await write(await icon(iconSvg, 1024, { pad: 0.14 }), `${AND_RES}/drawable/fliks_logo.png`); // android splash drawable

// Tizen — transparent mark; the platform composites it on its own tile.
await write(await icon(iconSvg, 1024, { pad: 0.04 }), 'client/tizen/icon.png');
// webOS — 400x400 store App Icon: opaque, flattened onto the tile colour
// (solid bg, no alpha) matching appinfo.json `iconColor` (#1d232a). The store
// replaces the appinfo icon/largeIcon (80x80 / 130x130 test icons) with this.
await write(await icon(iconSvg, 400, { bg: DARK, pad: 0.14 }), 'client/webos/icon.png');
// webOS — 1920x1080 loading splash (appinfo `splashBackground`): the mark on
// the brand base, same treatment as the iOS/Android splashes.
await write(await splash(iconSvg, 1920, 1080, 0.25), 'client/webos/splash.png');

// Splash — icon only, on the brand base
for (const [d, [w, h]] of Object.entries(AND_SPLASH)) await write(await splash(iconSvg, w, h, 0.40), `${AND_RES}/${d}/splash.png`);
for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  await write(await splash(iconSvg, 2732, 2732, 0.16), `client/ios/App/App/Assets.xcassets/Splash.imageset/${f}`); // iOS, slightly smaller
}

// macOS .icns (PNG entries 32→1024) + colour menu-bar icon
const ICNS = [['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]];
const icnsEntries = [];
for (const [type, size] of ICNS) icnsEntries.push({ type, buf: await icon(iconSvg, size, { bg: DARK, pad: 0.14 }) });
await write(buildIcns(icnsEntries), 'macos/Fliks/Resources/AppIcon.icns');
const MAC_MB = 'macos/Fliks/Resources/Assets.xcassets/MenuBarIcon.imageset';
await write(await icon(iconSvg, 18, { pad: 0.08 }), `${MAC_MB}/menubar-icon.png`);
await write(await icon(iconSvg, 36, { pad: 0.08 }), `${MAC_MB}/menubar-icon@2x.png`);

console.log('Done.');
