import { validateManifestShape } from './manifest-shape.validator';
import type { PluginManifest } from '../../common/plugin-contract';
import published from './__fixtures__/published-manifest-shapes.json';

/**
 * The `ui` and `events` sections of the manifests actually published to the signed catalogue.
 * Tightening this validator must never refuse a plugin already in the field.
 */
describe('validateManifestShape() against the published manifests', () => {
  for (const [name, shape] of Object.entries(published as Record<string, unknown>)) {
    it(`accepts ${name}`, () => {
      expect(validateManifestShape(shape as PluginManifest)).toEqual({ ok: true });
    });
  }
});
