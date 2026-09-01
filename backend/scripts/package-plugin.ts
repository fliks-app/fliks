#!/usr/bin/env node
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { PackagingError, packPluginDir } from '../src/modules/plugins/archive/package-plugin';

function main(): void {
  const args = process.argv.slice(2);
  const outIdx = args.findIndex((a) => a === '-o' || a === '--out');
  const out = outIdx === -1 ? undefined : args[outIdx + 1];
  if (outIdx !== -1 && (out === undefined || out.startsWith('-'))) {
    throw new PackagingError('-o needs a filename');
  }
  const dir = args.find((a, i) => !a.startsWith('-') && i !== outIdx + 1);
  if (!dir) throw new PackagingError('usage: package-plugin <plugin-dir> [-o output.fkplugin]');

  const { archive, manifest } = packPluginDir(resolve(dir));
  const outPath = resolve(out ?? `${manifest.id}-${manifest.version}.fkplugin`);
  writeFileSync(outPath, archive);

  console.log(`wrote ${outPath} (${archive.length} bytes) for ${manifest.id}@${manifest.version}`);
  console.log('unsigned: installable only on a core whose "allow unsigned plugins" plugin setting is on');
}

try {
  main();
} catch (err) {
  if (err instanceof PackagingError) {
    console.error(`package-plugin: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
