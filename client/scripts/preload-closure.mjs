// Rewrites dist index.html so it preloads the whole static import closure of main + polyfills: Angular caps modulepreload at 10
// links, which leaves the deeper chunks to a serial import waterfall. Prints the closure size, the figure the `initial` budget tracks.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const browser = join(process.argv[2] ?? 'dist/client', 'browser');
const indexPath = join(browser, 'index.html');
const html = readFileSync(indexPath, 'utf8');

const entries = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"/g)].map((m) => m[1]);
if (!entries.length) throw new Error('preload-closure: no entry script in index.html');

// esbuild emits static imports as `from"./x.js"` / `import"./x.js"`; a dynamic import is `import("./x.js")`.
const STATIC_IMPORT = /(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g;
const depth = new Map(entries.map((e) => [e, 0]));
const queue = [...entries];
while (queue.length) {
  const file = queue.shift();
  const src = readFileSync(join(browser, file), 'utf8');
  for (const [, dep] of src.matchAll(STATIC_IMPORT)) {
    if (depth.has(dep)) continue;
    depth.set(dep, depth.get(file) + 1);
    queue.push(dep);
  }
}

const chunks = [...depth].filter(([f]) => !entries.includes(f)).sort((a, b) => a[1] - b[1]);
const links = chunks.map(([f]) => `<link rel="modulepreload" href="${f}">`).join('');
const stripped = html.replace(/<link rel="modulepreload"[^>]*>/g, '');
writeFileSync(indexPath, stripped.replace('</head>', `${links}</head>`));

const styles = [...new Set([...html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"/g)].map((m) => m[1]))];
const files = [...depth.keys(), ...styles];
const bytes = files.reduce((n, f) => n + statSync(join(browser, f)).size, 0);
console.log(`preload-closure: ${chunks.length} chunks preloaded, ${files.length} initial files, ${bytes} bytes raw`);
