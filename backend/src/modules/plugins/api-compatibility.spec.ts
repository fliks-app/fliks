import * as semver from 'semver';
import { fliksRangeVersion, SUPPORTED_PLUGIN_API_VERSIONS, PLUGIN_API_VERSION } from '../../common/plugin-contract';
import { filterCatalog } from './catalog/catalog';
import type { CatalogDocument } from './catalog/catalog';

function catalogWith(pluginApi: number, fliks: string): CatalogDocument {
  return {
    plugins: [
      {
        id: 'acme.one',
        name: 'One',
        description: 'd',
        author: 'a',
        kind: 'data',
        versions: [{ version: '1.0.0', pluginApi, fliks, zipUrl: 'https://example.invalid/a.fkplugin', sha256: 'a'.repeat(64) }],
      },
    ],
  };
}

describe('plugin API compatibility', () => {
  it('accepts every version in the supported set, not just the newest', () => {
    expect(SUPPORTED_PLUGIN_API_VERSIONS).toContain(PLUGIN_API_VERSION);
    for (const api of SUPPORTED_PLUGIN_API_VERSIONS) {
      expect(filterCatalog(catalogWith(api, '>=2.0.0 <3.0.0'), SUPPORTED_PLUGIN_API_VERSIONS, '2.0.1').plugins[0]!.installable).toHaveLength(1);
    }
  });

  it('VERDICT: hides a retired pluginApi, so a removal inside one revision is impossible', () => {
    // 0 was retired when the upgrade window left `AcquisitionTarget.want`. A plugin built against
    // it must be refused outright rather than handed a `want` missing a field it filters on.
    expect(SUPPORTED_PLUGIN_API_VERSIONS).not.toContain(0);
    const result = filterCatalog(catalogWith(0, '>=3.0.0 <4.0.0'), SUPPORTED_PLUGIN_API_VERSIONS, '3.8.0');
    expect(result.plugins[0]!.installable).toHaveLength(0);
  });

  it('hides a version whose pluginApi the set does not carry', () => {
    const unsupported = Math.max(...SUPPORTED_PLUGIN_API_VERSIONS) + 1;
    const result = filterCatalog(catalogWith(unsupported, '>=2.0.0 <3.0.0'), SUPPORTED_PLUGIN_API_VERSIONS, '2.0.1');
    expect(result.plugins[0]!.installable).toHaveLength(0);
  });

  it('VERDICT: a release candidate resolves as its own release would, so the upgrade can be rehearsed', () => {
    expect(semver.satisfies(fliksRangeVersion('3.0.0-rc.1'), '>=3.0.0 <4.0.0')).toBe(true);
    const result = filterCatalog(catalogWith(PLUGIN_API_VERSION, '>=3.0.0 <4.0.0'), SUPPORTED_PLUGIN_API_VERSIONS, '3.0.0-rc.1');
    expect(result.plugins[0]!.installable).toHaveLength(1);
  });

  it('still refuses a range that genuinely excludes the running version', () => {
    const result = filterCatalog(catalogWith(PLUGIN_API_VERSION, '>=4.0.0 <5.0.0'), SUPPORTED_PLUGIN_API_VERSIONS, '3.0.0-rc.1');
    expect(result.plugins[0]!.installable).toHaveLength(0);
  });
});
