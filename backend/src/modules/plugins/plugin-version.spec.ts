import { CURRENT_FLIKS_VERSION, readVersionFrom } from './plugin-version';

/** `0.0.0` satisfies no plugin's declared range, so a version this cannot read disables every
 *  plugin at once — it must not depend on the directory core was launched from. */
describe('CURRENT_FLIKS_VERSION', () => {
  it('resolves from the module\'s own location, not the working directory', () => {
    expect(readVersionFrom(__dirname)).toBe(CURRENT_FLIKS_VERSION);
    expect(CURRENT_FLIKS_VERSION).not.toBe('0.0.0');
  });

  it('reports failure rather than inventing a version', () => {
    expect(readVersionFrom('/')).toBeNull();
  });
});
