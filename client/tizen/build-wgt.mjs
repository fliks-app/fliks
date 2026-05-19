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

// Force the stylesheet `<link>` to load synchronously (render-blocking).
// Angular's build pipeline emits the lazy pattern
// `<link rel="stylesheet" href="X" media="print" onload="this.media='all'">`
// for non-blocking critical-CSS extraction on the web. On Tizen file:// it
// breaks: the actual fetch fires AFTER `Angular.bootstrap()` calls
// `router.navigateByUrl()`, by which time the page URL has shifted to
// `file:///<route>`. Resolving the relative href against the new URL
// (combined with `<base href="./">`) lands at a non-existent path, the
// fetch 404s, `onload` never fires, the stylesheet stays in `media="print"`,
// and the page renders unstyled. Stripping `media`/`onload` makes the link
// render-blocking — fetched and applied BEFORE the SPA boots.
{
  const indexPath = resolve(stage, 'index.html');
  if (existsSync(indexPath)) {
    const before = readFileSync(indexPath, 'utf8');
    let after = before.replace(
      /<link rel="stylesheet" href="([^"]+)" media="print" onload="this\.media='all'">/g,
      '<link rel="stylesheet" href="$1">',
    );
    if (after !== before) {
      console.log('[tizen] forced render-blocking <link rel="stylesheet"> in index.html');
    }
    // Inject the Tizen WebAPIs bootstrap. `$WEBAPIS` is a magic prefix
    // that only Tizen's WebView expands at load time, populating
    // `window.webapis.*` (avplay, avinfo, …). The tag is added here
    // — not in src/index.html — so dev/web/Cast builds don't try to
    // load the path and trip the strict-MIME-type check in Chromium.
    if (!after.includes('$WEBAPIS/webapis/webapis.js')) {
      after = after.replace(
        '</head>',
        '  <script src="$WEBAPIS/webapis/webapis.js"></script>\n</head>',
      );
      console.log('[tizen] injected $WEBAPIS/webapis/webapis.js bootstrap');
    }
    if (after !== before) writeFileSync(indexPath, after, 'utf8');
  }
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
