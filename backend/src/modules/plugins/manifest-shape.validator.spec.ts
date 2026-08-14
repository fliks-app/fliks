import { validateManifestShape } from './manifest-shape.validator';
import { minimalDataManifest, minimalProcessManifest } from './archive/test-manifests';

/** The code names the offending section, so an author learns what to fix from it alone. */
function expectRefusal(manifest: unknown, code = 'PLUGIN_BAD_UI_CONTRIBUTIONS') {
  const result = validateManifestShape(manifest as Parameters<typeof validateManifestShape>[0]);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}

describe('validateManifestShape()', () => {
  it('accepts a minimal data manifest', () => {
    expect(validateManifestShape(minimalDataManifest()).ok).toBe(true);
  });

  it('accepts a data manifest using events[].webhook', () => {
    const manifest = minimalDataManifest({
      events: [{ event: 'media.imported', webhook: 'https://example.invalid/hook' }],
    });
    expect(validateManifestShape(manifest).ok).toBe(true);
  });

  it('accepts a well-shaped ui.contributions entry', () => {
    const manifest = minimalDataManifest({
      ui: { contributions: [{ id: 'x.nav', slot: 'nav.main', weight: 1, labelKey: 'x.nav', action: { kind: 'action', actionId: 'noop' } }] },
    });
    expect(validateManifestShape(manifest).ok).toBe(true);
  });

  it('accepts a well-shaped ui.configPages entry with fields', () => {
    const manifest = minimalDataManifest({
      ui: { configPages: [{ id: 'general', labelKey: 'x.general', fields: [{ key: 'endpoint_url', type: 'url', labelKey: 'x.endpoint' }] }] },
    });
    expect(validateManifestShape(manifest).ok).toBe(true);
  });

  it('accepts a well-shaped ui.releasePicker', () => {
    const pair = { search: '/search', grab: '/grab' };
    const manifest = minimalDataManifest({ ui: { releasePicker: { movie: pair, season: pair, episode: pair } } });
    expect(validateManifestShape(manifest).ok).toBe(true);
  });

  it('VERDICT: refuses a malformed shared field on the process tier too, not only on data', () => {
    // `ui` and `events` sit on the shared base, and `deriveCapabilities` reads them for either tier.
    const manifest = minimalProcessManifest({ 'plugin.js': 'f'.repeat(64) }, { ui: { contributions: 'not-an-array' as never } });
    expect(validateManifestShape(manifest).ok).toBe(false);
  });

  it('refuses ui as a non-object', () => {
    expectRefusal({ ...minimalDataManifest(), ui: 'not-an-object' }, 'PLUGIN_BAD_UI');
  });

  it('refuses ui.contributions as an object (the shape that crashes a blind for...of)', () => {
    expectRefusal({ ...minimalDataManifest(), ui: { contributions: { foo: 'bar' } } });
  });

  it('refuses ui.contributions as a string (the shape that silently fabricates entries)', () => {
    expectRefusal({ ...minimalDataManifest(), ui: { contributions: 'not-an-array' } });
  });

  it('refuses a ui.contributions entry missing a required field', () => {
    expectRefusal({ ...minimalDataManifest(), ui: { contributions: [{ id: 'x', slot: 'nav.main' }] } });
  });

  it('refuses ui.configPages as a non-array', () => {
    expectRefusal({ ...minimalDataManifest(), ui: { configPages: { id: 'general' } } }, 'PLUGIN_BAD_UI_CONFIG_PAGES');
  });

  it('refuses a ui.configPages entry whose fields is an object, not an array', () => {
    expectRefusal({
      ...minimalDataManifest(),
      ui: { configPages: [{ id: 'general', labelKey: 'x', fields: { key: 'endpoint_url' } }] },
    }, 'PLUGIN_BAD_UI_CONFIG_PAGES');
  });

  it('refuses a ui.configPages entry missing labelKey', () => {
    expectRefusal({ ...minimalDataManifest(), ui: { configPages: [{ id: 'general' }] } }, 'PLUGIN_BAD_UI_CONFIG_PAGES');
  });

  it('accepts a form page mixing a field, a caption, a group and a status item', () => {
    const manifest = minimalDataManifest({
      ui: {
        configPages: [
          {
            id: 'general',
            labelKey: 'x.general',
            fields: [
              { key: 'endpoint_url', type: 'url', labelKey: 'x.endpoint' },
              { kind: 'caption', textKey: 'x.blurb' },
              { kind: 'group', labelKey: 'x.advanced', fields: [{ key: 'timeout', type: 'number', labelKey: 'x.timeout' }] },
              { kind: 'status', labelKey: 'x.last_sync', settingKey: 'last_sync' },
            ],
          },
        ],
      },
    });
    expect(validateManifestShape(manifest).ok).toBe(true);
  });

  it('refuses a group nested inside a group', () => {
    expectRefusal(
      {
        ...minimalDataManifest(),
        ui: {
          configPages: [
            {
              id: 'general',
              labelKey: 'x.general',
              fields: [
                {
                  kind: 'group',
                  labelKey: 'x.outer',
                  // Carries key/type too, so nothing but the `kind` guard can refuse it.
                  fields: [
                    { kind: 'group', key: 'inner', type: 'text', labelKey: 'x.inner', fields: [] },
                  ],
                },
              ],
            },
          ],
        },
      },
      'PLUGIN_BAD_UI_CONFIG_PAGES',
    );
  });

  it('refuses a status item missing settingKey', () => {
    expectRefusal(
      { ...minimalDataManifest(), ui: { configPages: [{ id: 'general', labelKey: 'x', fields: [{ kind: 'status', labelKey: 'x.s' }] }] } },
      'PLUGIN_BAD_UI_CONFIG_PAGES',
    );
  });



  it('refuses a ui.releasePicker missing a context', () => {
    const pair = { search: '/search', grab: '/grab' };
    expectRefusal({ ...minimalDataManifest(), ui: { releasePicker: { movie: pair, season: pair } } }, 'PLUGIN_BAD_UI_RELEASE_PICKER');
  });

  it('refuses events as a non-array object', () => {
    expectRefusal({ ...minimalDataManifest(), events: { event: 'media.imported', webhook: 'https://example.invalid/hook' } }, 'PLUGIN_BAD_EVENTS');
  });

  it('refuses events as a string', () => {
    expectRefusal({ ...minimalDataManifest(), events: 'media.imported' }, 'PLUGIN_BAD_EVENTS');
  });

  it('refuses an events[] entry whose webhook is not a string', () => {
    expectRefusal({ ...minimalDataManifest(), events: [{ event: 'media.imported', webhook: 12345 }] }, 'PLUGIN_BAD_EVENTS');
  });
});
