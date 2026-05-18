#!/usr/bin/env node
/**
 * Bundle the Angular Tizen build into a `.wgt` (unsigned).
 *
 * - Reads `dist/client/browser/` (Angular build output).
 * - Adds `tizen/config.xml` + `tizen/icon.png` at the package root.
 * - Zips into `dist/Fliks-<version>.wgt`.
 *
 * Output is a sideloadable widget for Tizen TVs in developer mode. For
 * Smart Hub publication, hand it to `tizen package -t wgt -s <profile>`
 * with a Samsung-issued distributor profile.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { downlevelCss } from './downlevel-css.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '..');
const repoRoot = resolve(clientRoot, '..');

const distBrowser = resolve(clientRoot, 'dist/client/browser');
if (!existsSync(distBrowser)) {
  console.error(
    `[tizen] missing ${distBrowser}. Run \`npm run build -- --configuration tizen\` first.`,
  );
  process.exit(1);
}

const stage = resolve(clientRoot, 'dist/tizen-stage');
execSync(`rm -rf "${stage}" && mkdir -p "${stage}"`, { stdio: 'inherit' });
execSync(`cp -R "${distBrowser}/." "${stage}/"`, { stdio: 'inherit' });

// Tizen 6.5 ships Chromium ~85, which predates cascade layers, `:is`/`:where`,
// `:has`, `:focus-visible`, logical properties, `oklch()`/`color-mix()`,
// container queries, and `@starting-style`. Run the downlevel pass on every
// `styles-*.css` chunk now so the WGT contains parser-friendly CSS.
const stylesFiles = readdirSync(stage).filter((f) => /^styles-.*\.css$/.test(f));
for (const f of stylesFiles) {
  const p = resolve(stage, f);
  const before = readFileSync(p, 'utf8');
  const after = await downlevelCss(before, p);
  writeFileSync(p, after);
  console.log(`[tizen] downlevelled ${f}: ${before.length} → ${after.length} bytes`);
}

const configXml = resolve(here, 'config.xml');
const iconSrc = resolve(here, 'icon.png');
const iconFallback = resolve(clientRoot, 'public/fliks-mark.png');
copyFileSync(configXml, resolve(stage, 'config.xml'));
copyFileSync(existsSync(iconSrc) ? iconSrc : iconFallback, resolve(stage, 'icon.png'));

const pkg = JSON.parse(readFileSync(resolve(clientRoot, 'package.json'), 'utf8'));
const version = pkg.version ?? '0.0.0';
const distDir = resolve(clientRoot, 'dist');
const out = resolve(distDir, `Fliks-${version}.wgt`);

execSync(`rm -f "${out}"`, { stdio: 'inherit' });
// `.wgt` is a plain zip file at root level — `cd` so paths inside the
// archive are relative to the package contents, not to the repo root.
execSync(`cd "${stage}" && zip -qr "${out}" .`, { stdio: 'inherit' });

console.log(`[tizen] wrote ${relative(repoRoot, out)}`);
