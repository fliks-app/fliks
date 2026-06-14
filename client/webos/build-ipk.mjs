#!/usr/bin/env node
/**
 * Bundle the Angular webOS build into an `.ipk`.
 *
 * Uses `ares-package` from `@webosose/ares-cli` (devDependency). The
 * resulting `.ipk` is sideloadable on LG TVs in developer mode, and is
 * the same artifact format that goes through LG Content Manager for
 * Smart Hub publication.
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '..');
const repoRoot = resolve(clientRoot, '..');

const distBrowser = resolve(clientRoot, 'dist/client/browser');
if (!existsSync(distBrowser)) {
  console.error(
    `[webos] missing ${distBrowser}. Run \`npm run build -- --configuration webos\` first.`,
  );
  process.exit(1);
}

const stage = resolve(clientRoot, 'dist/webos-stage');
execSync(`rm -rf "${stage}" && mkdir -p "${stage}"`, { stdio: 'inherit' });
execSync(`cp -R "${distBrowser}/." "${stage}/"`, { stdio: 'inherit' });

// Sync appinfo.json's version with package.json so a single `npm version
// patch` keeps both Capacitor / Tizen / webOS aligned without touching
// three files manually.
const pkg = JSON.parse(readFileSync(resolve(clientRoot, 'package.json'), 'utf8'));
const appInfoPath = resolve(here, 'appinfo.json');
const appInfo = JSON.parse(readFileSync(appInfoPath, 'utf8'));
appInfo.version = pkg.version ?? appInfo.version;
writeFileSync(resolve(stage, 'appinfo.json'), JSON.stringify(appInfo, null, 2));

const iconSrc = resolve(here, 'icon.png');
const iconFallback = resolve(clientRoot, 'public/icons/icon-512x512.png');
copyFileSync(existsSync(iconSrc) ? iconSrc : iconFallback, resolve(stage, 'icon.png'));

// Optional 1920x1080 loading splash (appinfo `splashBackground`). Only staged
// when present so the IPK stays valid even if the asset hasn't been generated.
const splashSrc = resolve(here, 'splash.png');
if (existsSync(splashSrc)) copyFileSync(splashSrc, resolve(stage, 'splash.png'));

const distDir = resolve(clientRoot, 'dist');
mkdirSync(distDir, { recursive: true });
// `ares-package` is the per-binary entry of `@webosose/ares-cli`
// (not a subcommand of an `ares` umbrella). Resolve it from the local
// node_modules so this script works the same way locally and in CI.
const aresPackage = resolve(clientRoot, 'node_modules/.bin/ares-package');
if (!existsSync(aresPackage)) {
  console.error(
    `[webos] missing ${aresPackage}. Run \`npm ci\` to install @webosose/ares-cli.`,
  );
  process.exit(1);
}
// Angular emits already-minified ESM with modern syntax that
// ares-package's bundled UglifyJS chokes on. `--no-minify` (`-n`) keeps
// the bundle intact — the size penalty is nil because Angular's own
// optimizer ran first.
execSync(`"${aresPackage}" -n -o "${distDir}" "${stage}"`, {
  stdio: 'inherit',
  cwd: clientRoot,
});

console.log(`[webos] .ipk written under ${relative(repoRoot, distDir)}/`);
