import { readFileSync } from 'fs';
import { join } from 'path';
import { parseManifest } from '../../src/modules/plugins/archive/manifest-parser';
import { validateManifestShape } from '../../src/modules/plugins/manifest-shape.validator';
import { emit } from './_util';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const PROCESS = {
  id: 'fliks.sample', pluginApi: 2, name: 'Sample', version: '1.0.0', fliks: '>=5.0.0 <6.0.0', author: 'a', description: 'd',
  license: 'MIT', logo: 'logo.svg', kind: 'process', runtime: 'wasm', memoryMb: 64, files: {},
  database: { schema: true, coreRefs: ['media'] }, routes: [{ method: 'GET', path: '/x', policy: 'read:Settings' }],
  scopes: ['media:read'], ingestRoots: ['/data/in'],
};
const DATA = {
  id: 'fliks.data', pluginApi: 2, name: 'Data', version: '1.0.0', fliks: '>=5.0.0', author: 'a', description: 'd', license: 'MIT',
  logo: 'logo.svg', kind: 'data', homepage: 'https://example.invalid', i18n: { en: { 'fliks.data.x': 'X' } },
};
const VALUES: unknown[] = [undefined, null, 42, 'x', '', [], {}, true];

const parseInputs: unknown[] = [];
for (const base of [PROCESS, DATA]) {
  parseInputs.push(base);
  for (const key of Object.keys(base))
    for (const v of VALUES) {
      const m: Record<string, unknown> = clone(base);
      if (v === undefined) delete m[key];
      else m[key] = v;
      parseInputs.push(m);
    }
  parseInputs.push({ ...clone(base), unknownKey: 1 });
}
const p = (patch: Record<string, unknown>) => ({ ...clone(PROCESS), ...patch });
parseInputs.push(
  p({ scopes: ['media:read', 'nope'] }), p({ scopes: [] }), p({ ingestRoots: ['relative'] }), p({ ingestRoots: ['/'] }),
  p({ ingestRoots: ['C:\\data'] }), p({ ingestRoots: ['C:\\'] }), p({ ingestRoots: ['/a/../b'] }), p({ database: { schema: 'yes', coreRefs: [] } }),
  p({ database: { schema: true, coreRefs: [1] } }), p({ files: { a: 1 } }), p({ routes: [{ method: 'GET', path: '/x' }] }),
  p({ routes: [{ method: 'GET', path: '/x', policy: 'read:Settings', objectGuard: 3 }] }), p({ jobs: [] }), p({ permissions: [] }),
  p({ checklist: {} }), p({ kind: 'data' }), p({ kind: 'other' }), { ...clone(DATA), i18n: { en: { 'other.x': 'X' } } },
  { ...clone(DATA), i18n: { en: { 'fliks.data.x': 1 } } }, { ...clone(DATA), i18n: 'x' },
);

const shapes = JSON.parse(readFileSync(join(__dirname, '../../src/modules/plugins/__fixtures__/published-manifest-shapes.json'), 'utf8'));
const shapeInputs: unknown[] = [];
for (const base of Object.values(shapes) as Record<string, any>[]) {
  shapeInputs.push(base);
  for (const key of Object.keys(base.ui ?? {}))
    for (const v of VALUES) {
      const m = clone(base);
      if (v === undefined) delete m.ui[key];
      else m.ui[key] = v;
      shapeInputs.push(m);
    }
  for (const listKey of ['contributions', 'configPages'])
    for (const [i, item] of (base.ui?.[listKey] ?? []).entries())
      for (const k of Object.keys(item)) {
        const m = clone(base);
        delete m.ui[listKey][i][k];
        shapeInputs.push(m);
      }
  if (base.events) {
    for (const v of VALUES) shapeInputs.push({ ...clone(base), events: v === undefined ? [] : v });
    shapeInputs.push({ ...clone(base), events: [{ event: 'media.imported' }] }, { ...clone(base), events: [1] });
  }
  for (const v of VALUES) shapeInputs.push({ ...clone(base), ui: v });
}

// Nest runs Node processes; the Rust wasm host reads the same manifest with `runtime: "wasm"`.
const toNode = (m: any) => (m && m.runtime === 'wasm' ? { ...m, runtime: 'node' } : m);

const inputs = [
  ...parseInputs.map((manifest) => ({ kind: 'parse', manifest })),
  ...shapeInputs.map((manifest) => ({ kind: 'shape', manifest })),
];

function run(i: any): unknown {
  if (i.kind === 'parse') return { parsed: parseManifest(Buffer.from(JSON.stringify(toNode(i.manifest)))) !== null };
  const r = validateManifestShape(i.manifest);
  return 'code' in r ? { code: r.code } : { ok: true };
}

void emit('plugin-manifest', inputs, run);
