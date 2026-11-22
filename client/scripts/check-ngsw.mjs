// Fails the build when a file listed in ngsw.json no longer matches its hash: the service worker then refuses to install the update.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const browser = join(process.argv[2] ?? 'dist/client', 'browser');
const { hashTable } = JSON.parse(readFileSync(join(browser, 'ngsw.json'), 'utf8'));

const bad = Object.entries(hashTable).filter(([url, hash]) => {
  const file = join(browser, url);
  return !existsSync(file) || createHash('sha1').update(readFileSync(file)).digest('hex') !== hash;
});
if (bad.length) throw new Error(`check-ngsw: ngsw.json is stale for ${bad.map(([url]) => url).join(', ')}`);
console.log(`check-ngsw: ${Object.keys(hashTable).length} files match ngsw.json`);
