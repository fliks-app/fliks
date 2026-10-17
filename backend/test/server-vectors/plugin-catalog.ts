import { extractCachedDenyList, filterCatalog, findDenial, parseCatalogDocument } from '../../src/modules/plugins/catalog/catalog';
import { emit } from './_util';

const OK = 'b'.repeat(64);
const ver = (version: string, extra: Record<string, unknown> = {}) =>
  ({ version, pluginApi: 2, fliks: '>=5.0.0 <6.0.0', zipUrl: 'https://example.invalid/a.zip', sha256: OK, ...extra });
const plugin = (extra: Record<string, unknown> = {}) =>
  ({ id: 'fliks.a', name: 'A', description: 'd', author: 'x', kind: 'process', versions: [ver('1.0.0')], ...extra });

const DOCS: unknown[] = [
  { plugins: [plugin()] },
  { plugins: [plugin({ logo: 'logo.svg' }), plugin({ id: 'fliks.b', kind: 'data', versions: [ver('2.0.0'), ver('1.5.0')] })] },
  { plugins: [] },
  { plugins: [plugin()], denyList: [{ pluginId: 'fliks.a', reason: 'bad' }, { pluginId: '', reason: 'x' }, { pluginId: 'fliks.a', reason: '' },
    { pluginId: 'fliks.a', version: 1, reason: 'x' }, { pluginId: 'fliks.a', version: '1.0.0', sha256: OK, reason: 'r' }, 'junk', null] },
  { plugins: [plugin()], denyList: 'nope' },
  { plugins: [plugin({ id: '' })] },
  { plugins: [plugin({ kind: 'other' })] },
  { plugins: [plugin({ logo: 3 })] },
  { plugins: [plugin({ versions: [] })] },
  { plugins: [plugin({ versions: [ver('1.0.0', { fliks: 'not a range' })] })] },
  { plugins: [plugin({ versions: [ver('1.0.0', { pluginApi: '2' })] })] },
  { plugins: [plugin({ versions: [ver('', {})] })] },
  { plugins: [plugin({ name: null })] },
  { plugins: 'x' },
  [{ plugins: [] }],
  { plugin: [] },
  null,
  { plugins: [plugin({ extra: { deep: true }, versions: [ver('1.0.0', { note: 'kept' })] })] },
];

const inputs: unknown[] = [];
for (const doc of DOCS) inputs.push({ kind: 'parse', text: JSON.stringify(doc) });
inputs.push({ kind: 'parse', text: '{"plugins": [' }, { kind: 'parse', text: '' }, { kind: 'parse', text: '﻿{"plugins":[]}' });

const SOURCES = [
  { denyList: [{ pluginId: 'fliks.a', reason: 'any version' }], signedByKeyId: 'k1' },
  { denyList: [{ pluginId: 'fliks.b', version: '1.0.0', reason: 'one version' }, { pluginId: 'fliks.b', sha256: OK, reason: 'one build' }], signedByKeyId: 'k2' },
  { denyList: [{ pluginId: 'fliks.c', reason: 'unsigned source' }], signedByKeyId: null },
  { denyList: [{ pluginId: 'fliks.d', reason: '' }, { pluginId: 'fliks.d', reason: 'second' }], signedByKeyId: 'k1' },
];
for (const pluginId of ['fliks.a', 'fliks.b', 'fliks.c', 'fliks.d', 'fliks.e'])
  for (const version of ['1.0.0', '2.0.0'])
    for (const sha256 of [OK, 'c'.repeat(64)])
      for (const verifiedByKeyId of ['k1', 'k2', null])
        inputs.push({ kind: 'deny', cached: SOURCES, pkg: { pluginId, version, sha256, verifiedByKeyId } });

function run(i: any): unknown {
  if (i.kind === 'parse') {
    const doc = parseCatalogDocument(Buffer.from(i.text, 'utf8'));
    return doc && { doc, filtered: filterCatalog(doc, [2], '5.0.0') };
  }
  const sources = i.cached.map((c: Record<string, unknown>) => extractCachedDenyList(c));
  return findDenial(i.pkg, sources);
}

void emit('plugin-catalog', inputs, run);
