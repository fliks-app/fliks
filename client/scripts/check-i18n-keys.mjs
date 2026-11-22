// Fails when the locale files disagree on keys, or a key is referenced nowhere.
// References are searched in the client, the server (error ids, QoE reasons) and the native shells (push text).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const LANGS = ['en', 'fr', 'de', 'es', 'it', 'pt'];
const SOURCE_DIRS = ['client/src', 'client/ios', 'client/android/app/src', 'appletv/Sources', 'server/crates', 'desktop', 'cast-receiver'];
const SOURCE_EXT = /\.(ts|html|swift|kt|java|rs|mjs|js)$/;
const SKIP_DIR = /(^|\/)(node_modules|target|build|dist|Pods|\.angular)(\/|$)/;

function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') flatten(v, `${prefix}${k}.`, out);
    else out.set(`${prefix}${k}`, v);
  }
  return out;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (SKIP_DIR.test(p)) continue;
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (SOURCE_EXT.test(name) && !/\.(spec|test)\./.test(name)) yield p;
  }
}

const locales = Object.fromEntries(
  LANGS.map((l) => [l, flatten(JSON.parse(readFileSync(join(root, 'client/public/i18n', `${l}.json`), 'utf8')))]),
);
let failed = false;

for (const l of LANGS.slice(1)) {
  const missing = [...locales.en.keys()].filter((k) => !locales[l].has(k));
  const extra = [...locales[l].keys()].filter((k) => !locales.en.has(k));
  for (const k of missing) console.error(`${l}: missing ${k}`);
  for (const k of extra) console.error(`${l}: extra ${k}`);
  if (missing.length || extra.length) failed = true;
}

let text = '';
for (const dir of SOURCE_DIRS) for (const f of walk(join(root, dir))) text += readFileSync(f, 'utf8') + '\n';

// A key built at run time shows as `'prefix.'`, `'prefix_'`, `` `prefix.${``, Rust `format!("prefix.{` or Swift `"prefix.\(`.
const prefixes = new Set();
for (const m of text.matchAll(/['"`]([a-zA-Z][a-zA-Z0-9_.]*[._])(?:['"`]|\$\{|\{|\\\()/g)) prefixes.add(m[1]);
const prefixList = [...prefixes];

const unused = [...locales.en.keys()].filter((key) => {
  const base = key.replace(/_(one|other)$/, '');
  return !text.includes(base) && !prefixList.some((p) => base.startsWith(p));
});
for (const k of unused) console.error(`unused: ${k}`);
if (unused.length) failed = true;

console.log(`${locales.en.size} keys, ${unused.length} unused`);
process.exit(failed ? 1 : 0);
