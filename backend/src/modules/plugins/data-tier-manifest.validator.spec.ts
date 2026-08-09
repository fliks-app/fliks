import { validateDataTierManifest } from './data-tier-manifest.validator';
import { minimalDataManifest, minimalProcessManifest } from './archive/test-manifests';
import { PluginRefusalCode } from './archive/refusal-codes';

function expectRefusal(manifest: unknown, code: PluginRefusalCode) {
  const result = validateDataTierManifest(manifest as Parameters<typeof validateDataTierManifest>[0]);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}

describe('validateDataTierManifest()', () => {
  it('accepts a minimal data manifest', () => {
    expect(validateDataTierManifest(minimalDataManifest()).ok).toBe(true);
  });

  it('accepts a data manifest using provides.* and events[].webhook', () => {
    const manifest = minimalDataManifest({
      provides: { indexers: [{ id: 'x' }] },
      events: [{ webhook: 'https://example.invalid/hook' }],
    });
    expect(validateDataTierManifest(manifest).ok).toBe(true);
  });

  it('is a no-op for a process manifest', () => {
    const manifest = minimalProcessManifest({ 'plugin.js': 'f'.repeat(64) });
    expect(validateDataTierManifest(manifest).ok).toBe(true);
  });

  it('PLUGIN_DATA_HAS_FILES: refuses a data manifest carrying a files map (incl. plugin.js)', () => {
    expectRefusal({ ...minimalDataManifest(), files: { 'plugin.js': 'f'.repeat(64) } }, 'PLUGIN_DATA_HAS_FILES');
  });

  it('PLUGIN_DATA_HAS_ROUTES: refuses a data manifest declaring routes', () => {
    expectRefusal({ ...minimalDataManifest(), routes: [] }, 'PLUGIN_DATA_HAS_ROUTES');
  });

  it('PLUGIN_DATA_HAS_DATABASE: refuses a data manifest declaring a database schema', () => {
    expectRefusal({ ...minimalDataManifest(), database: { schema: true, coreRefs: [] } }, 'PLUGIN_DATA_HAS_DATABASE');
  });

  it('PLUGIN_DATA_HAS_JOBS: refuses a data manifest declaring jobs', () => {
    expectRefusal({ ...minimalDataManifest(), jobs: [] }, 'PLUGIN_DATA_HAS_JOBS');
  });

  it('PLUGIN_DATA_HAS_INGEST_ROOTS: refuses a data manifest declaring ingestRoots', () => {
    expectRefusal({ ...minimalDataManifest(), ingestRoots: [] }, 'PLUGIN_DATA_HAS_INGEST_ROOTS');
  });

  it('PLUGIN_DATA_HAS_MEMORY_MB: refuses a data manifest declaring memoryMb', () => {
    expectRefusal({ ...minimalDataManifest(), memoryMb: 256 }, 'PLUGIN_DATA_HAS_MEMORY_MB');
  });

  it('PLUGIN_DATA_HAS_RUNTIME: refuses a data manifest declaring runtime', () => {
    expectRefusal({ ...minimalDataManifest(), runtime: 'node' }, 'PLUGIN_DATA_HAS_RUNTIME');
  });

  it('PLUGIN_DATA_HAS_PERMISSIONS: refuses a data manifest declaring permissions', () => {
    expectRefusal({ ...minimalDataManifest(), permissions: [] }, 'PLUGIN_DATA_HAS_PERMISSIONS');
  });

  it('PLUGIN_DATA_HAS_CHECKLIST: refuses a data manifest declaring a checklist', () => {
    expectRefusal({ ...minimalDataManifest(), checklist: [] }, 'PLUGIN_DATA_HAS_CHECKLIST');
  });

  it('PLUGIN_BAD_MANIFEST: refuses an unknown top-level key not covered by a specific rule', () => {
    expectRefusal({ ...minimalDataManifest(), legacyPaths: {} }, 'PLUGIN_BAD_MANIFEST');
  });
});
