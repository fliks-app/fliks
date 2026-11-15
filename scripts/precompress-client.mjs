#!/usr/bin/env node
// Writes `.br` and `.gz` siblings of the built web client's text files, served by fliks-server.
// Usage: node scripts/precompress-client.mjs <dir>
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: precompress-client.mjs <dir>');
  process.exit(1);
}
const TEXT = new Set(['.js', '.css', '.html', '.json', '.svg', '.txt']);

let count = 0;
for (const rel of readdirSync(dir, { recursive: true })) {
  const file = join(dir, rel);
  if (!TEXT.has(extname(file)) || !statSync(file).isFile()) continue;
  const raw = readFileSync(file);
  const br = brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  const gz = gzipSync(raw, { level: 9 });
  // A sibling no smaller than the file would only cost bytes.
  if (br.length < raw.length) writeFileSync(`${file}.br`, br);
  if (gz.length < raw.length) writeFileSync(`${file}.gz`, gz);
  count++;
}
console.log(`precompressed ${count} files in ${dir}`);
