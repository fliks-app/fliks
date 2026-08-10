import type { DataPluginManifest, ProcessPluginManifest } from '../../../common/plugin-contract';

/** Minimal, structurally-valid `data` manifest — spread `overrides` to break one field at a time. */
export function minimalDataManifest(overrides: Partial<DataPluginManifest> = {}): DataPluginManifest {
  return {
    id: 'fliks.testplugin',
    pluginApi: 0,
    name: 'Test plugin',
    version: '1.0.0',
    fliks: '>=2.1.0 <3.0.0',
    author: 'Fliks',
    description: 'A spec fixture.',
    license: 'MIT',
    logo: 'logo.svg',
    kind: 'data',
    ...overrides,
  };
}

/** Minimal, structurally-valid `process` manifest — `files` must match the archive's actual entries+hashes. */
export function minimalProcessManifest(
  files: Record<string, string>,
  overrides: Partial<ProcessPluginManifest> = {},
): ProcessPluginManifest {
  return {
    id: 'fliks.testprocessplugin',
    pluginApi: 0,
    name: 'Test process plugin',
    version: '1.0.0',
    fliks: '>=2.1.0 <3.0.0',
    author: 'Fliks',
    description: 'A spec fixture.',
    license: 'MIT',
    logo: 'logo.png',
    kind: 'process',
    runtime: 'node',
    memoryMb: 256,
    files,
    database: { schema: true, coreRefs: [] },
    routes: [],
    scopes: ['media:read'],
    ingestRoots: [],
    ...overrides,
  };
}
