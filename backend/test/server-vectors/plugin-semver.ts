import { fliksRangeVersion } from '../../src/common/plugin-contract/fliks-range';
import { filterCatalog, parseCatalogDocument } from '../../src/modules/plugins/catalog/catalog';
import * as semver from 'semver';
import { emit } from './_util';

const VERSIONS = ['5.0.0', '5.2.3', '5.0.0-rc.1', '6.0.0-beta.2', '4.9.9', ' 5.1.0 ', 'v5.1.0', '5.1', 'garbage', '5.0.0+build.7', '10.0.0'];
const RANGES = ['>=5.0.0 <6.0.0', '^5.0.0', '~5.2.0', '5.x', '*', '>=6.0.0', '<5.0.0', '5.0.0 - 5.5.0', '>=5.0.0-rc.0 <6.0.0',
  '^5.0.0 || ^6.0.0', '=5.0.0', 'not a range', '', '>=4.0.0 <5.0.0', '^5.1'];
const OK = 'a'.repeat(64);
const entry = (version: string, fliks: string, extra: Record<string, unknown> = {}) =>
  ({ version, pluginApi: 2, fliks, zipUrl: 'https://example.invalid/p.zip', sha256: OK, ...extra });

const inputs: unknown[] = [];
for (const version of VERSIONS) inputs.push({ kind: 'range-version', version });
for (const version of VERSIONS) for (const range of RANGES) inputs.push({ kind: 'satisfies', version, range });
const VERSION_SETS = [
  [entry('1.1.0', '>=5.0.0 <6.0.0'), entry('1.0.0', '>=5.0.0 <6.0.0'), entry('2.0.0', '>=6.0.0 <7.0.0'), entry('3.0.0', '>=5.5.0')],
  [entry('1.0.0', '>=4.0.0 <5.0.0'), entry('0.9.0', '^3.0.0')],
  [entry('1.0.0', '>=5.0.0', { pluginApi: 1 }), entry('1.0.1', '>=5.0.0', { sha256: '0'.repeat(64) }), entry('1.0.2', '>=5.0.0', { zipUrl: '' })],
  [entry('1.0.0', '>=5.0.0', { sha256: 'A'.repeat(64) }), entry('1.10.0', '*'), entry('1.9.0', '*'), entry('1.0.0-beta.1', '*')],
  [entry('2.0.0', '>=7.0.0'), entry('2.1.0', '>=6.1.0 <8'), entry('2.2.0', '>=6.0.5')],
];
for (const running of ['5.0.0', '5.6.0', '6.0.0-rc.1', '4.0.0'])
  for (const versions of VERSION_SETS)
    for (const skip of [false, true]) inputs.push({ kind: 'filter', running, skip, versions });

function run(i: any): unknown {
  switch (i.kind) {
    case 'range-version':
      return fliksRangeVersion(i.version);
    case 'satisfies':
      try {
        return semver.satisfies(fliksRangeVersion(i.version), i.range);
      } catch {
        return false;
      }
    default: {
      const bytes = Buffer.from(JSON.stringify({ plugins: [{ id: 'p', name: 'P', description: '', author: 'a', kind: 'process', versions: i.versions }] }));
      const doc = parseCatalogDocument(bytes);
      return doc && filterCatalog(doc, [2], i.running, { skipFliksRange: i.skip });
    }
  }
}

void emit('plugin-semver', inputs, run);
