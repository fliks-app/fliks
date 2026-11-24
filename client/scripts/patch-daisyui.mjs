// `[class~=not-prose] *` makes Chrome restyle every descendant on any class change (~85 ms per
// <html> class toggle on a tablet). Delete this script once daisyUI ships `.not-prose`: fliks-app/fliks#2993.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = dirname(createRequire(import.meta.url).resolve('daisyui'));
const selector = /\[class~=(\\?"?)not-prose\1\]/g;

for (const file of ['components/button/object.js', 'components/button.css', 'daisyui.css']) {
  const path = join(root, file);
  const src = readFileSync(path, 'utf8');
  const patched = src.replace(selector, '.not-prose');
  if (patched !== src) writeFileSync(path, patched);
  else if (!src.includes('.not-prose')) throw new Error(`daisyUI changed ${file}: review scripts/patch-daisyui.mjs`);
}
