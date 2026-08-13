import { parseCatalogDocument, filterCatalog, type CatalogDocument, type CatalogVersionEntry } from './catalog';
import { PLUGIN_API_VERSION, SUPPORTED_PLUGIN_API_VERSIONS } from '../../../common/plugin-contract';

/** A `fliks` range every test can rely on matching this repo's own `package.json` version
 *  (same convention as `plugin-registry.service.spec.ts`'s `COMPATIBLE_RANGE`). */
const COMPATIBLE_RANGE = '>=1.0.0 <3.0.0';

function version(overrides: Partial<CatalogVersionEntry> = {}): CatalogVersionEntry {
  return { version: '1.0.0', pluginApi: PLUGIN_API_VERSION, fliks: COMPATIBLE_RANGE, ...overrides };
}

function document(overrides: Partial<CatalogDocument['plugins'][number]> = {}): CatalogDocument {
  return {
    plugins: [
      {
        id: 'fliks.test-plugin',
        name: 'Test plugin',
        description: 'A fixture.',
        author: 'Fliks',
        kind: 'data',
        versions: [version()],
        ...overrides,
      },
    ],
  };
}

describe('parseCatalogDocument()', () => {
  it('parses a structurally valid document', () => {
    const bytes = Buffer.from(JSON.stringify(document()), 'utf8');
    expect(parseCatalogDocument(bytes)).toEqual(document());
  });

  it('returns null for bytes that are not JSON at all', () => {
    expect(parseCatalogDocument(Buffer.from('not json{{{', 'utf8'))).toBeNull();
  });

  it('returns null when a version entry is missing a required field', () => {
    const doc = document({ versions: [{ version: '1.0.0', fliks: COMPATIBLE_RANGE } as CatalogVersionEntry] });
    expect(parseCatalogDocument(Buffer.from(JSON.stringify(doc), 'utf8'))).toBeNull();
  });

  it('returns null when a plugin entry has no versions at all', () => {
    const doc = document({ versions: [] });
    expect(parseCatalogDocument(Buffer.from(JSON.stringify(doc), 'utf8'))).toBeNull();
  });

  it('returns null when a version declares an invalid semver range', () => {
    const doc = document({ versions: [version({ fliks: 'not-a-range' })] });
    expect(parseCatalogDocument(Buffer.from(JSON.stringify(doc), 'utf8'))).toBeNull();
  });

  it('accepts a plugin entry with a string logo and rejects a non-string one', () => {
    const withLogo = document({ logo: 'https://example.com/logo.png' });
    expect(parseCatalogDocument(Buffer.from(JSON.stringify(withLogo), 'utf8'))).toEqual(withLogo);

    const badLogo = document({ logo: 42 as unknown as string });
    expect(parseCatalogDocument(Buffer.from(JSON.stringify(badLogo), 'utf8'))).toBeNull();
  });
});

describe('filterCatalog()', () => {
  it('lists a version whose pluginApi matches and whose fliks range is satisfied', () => {
    const doc = document({ versions: [version()] });
    const result = filterCatalog(doc, SUPPORTED_PLUGIN_API_VERSIONS, '2.0.1');
    expect(result.plugins[0].installable).toEqual([version()]);
    expect(result.plugins[0].hidden).toBeNull();
  });

  it('hides a version whose pluginApi does not match exactly, and counts it', () => {
    const mismatched = version({ pluginApi: PLUGIN_API_VERSION + 1, fliks: COMPATIBLE_RANGE });
    const doc = document({ versions: [mismatched] });
    const result = filterCatalog(doc, SUPPORTED_PLUGIN_API_VERSIONS, '2.0.1');
    expect(result.plugins[0].installable).toEqual([]);
    // No version number reveals it: the mismatch is the plugin API, not the range.
    expect(result.plugins[0].hidden).toEqual({ count: 1, minFliksVersion: null });
  });

  it('hides a version whose fliks range excludes the running core version, and counts it', () => {
    const tooNew = version({ fliks: '>=5.0.0 <6.0.0' });
    const doc = document({ versions: [tooNew] });
    const result = filterCatalog(doc, SUPPORTED_PLUGIN_API_VERSIONS, '2.0.1');
    expect(result.plugins[0].installable).toEqual([]);
    expect(result.plugins[0].hidden).toEqual({ count: 1, minFliksVersion: '5.0.0' });
  });

  it('reports the minimum core version across every hidden version’s floor, not the first one', () => {
    const needsFive = version({ version: '2.0.0', fliks: '>=5.0.0 <6.0.0' });
    const needsFour = version({ version: '3.0.0', fliks: '>=4.0.0 <5.0.0' });
    const doc = document({ versions: [needsFive, needsFour] });
    const result = filterCatalog(doc, SUPPORTED_PLUGIN_API_VERSIONS, '2.0.1');
    expect(result.plugins[0].hidden).toEqual({ count: 2, minFliksVersion: '4.0.0' });
  });

  it('offers no upgrade when every hidden version sits below the running core version', () => {
    // The range's upper bound is already behind us: upgrading moves further away.
    const tooOld = version({ fliks: '>=1.0.0 <2.0.0' });
    const doc = document({ versions: [tooOld] });
    const result = filterCatalog(doc, SUPPORTED_PLUGIN_API_VERSIONS, '2.0.1');
    expect(result.plugins[0].hidden).toEqual({ count: 1, minFliksVersion: null });
  });

  it('keeps a plugin in the result with an empty installable list when every version is hidden', () => {
    const doc = document({ versions: [version({ fliks: '>=5.0.0 <6.0.0' })] });
    const result = filterCatalog(doc, SUPPORTED_PLUGIN_API_VERSIONS, '2.0.1');
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].id).toBe('fliks.test-plugin');
    expect(result.plugins[0].installable).toEqual([]);
    expect(result.plugins[0].hidden?.count).toBe(1);
  });

  it('separates installable and hidden versions of the same plugin', () => {
    const ok = version({ version: '1.0.0' });
    const tooNew = version({ version: '2.0.0', fliks: '>=5.0.0 <6.0.0' });
    const doc = document({ versions: [ok, tooNew] });
    const result = filterCatalog(doc, SUPPORTED_PLUGIN_API_VERSIONS, '2.0.1');
    expect(result.plugins[0].installable).toEqual([ok]);
    expect(result.plugins[0].hidden).toEqual({ count: 1, minFliksVersion: '5.0.0' });
  });

  it('carries an optional logo URL through unchanged, and omits it when absent', () => {
    const withLogo = filterCatalog(document({ logo: 'https://example.com/logo.png' }), SUPPORTED_PLUGIN_API_VERSIONS, '2.0.1');
    expect(withLogo.plugins[0].logo).toBe('https://example.com/logo.png');

    const withoutLogo = filterCatalog(document(), SUPPORTED_PLUGIN_API_VERSIONS, '2.0.1');
    expect(withoutLogo.plugins[0].logo).toBeUndefined();
  });
});
