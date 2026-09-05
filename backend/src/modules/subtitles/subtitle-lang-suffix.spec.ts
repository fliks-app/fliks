import { assertSafeLangSuffix } from './subtitle-path.util';

/**
 * The suffix is built from a provider- or client-supplied language, and
 * `normalizeLanguageCode` returns an unrecognised tag unchanged.
 */
describe('assertSafeLangSuffix', () => {
  it('VERDICT: refuses a language that would escape the media folder', () => {
    expect(() => assertSafeLangSuffix('x/../../../../tmp/pwn')).toThrow();
    expect(() => assertSafeLangSuffix('../../etc/cron.d/x')).toThrow();
    expect(() => assertSafeLangSuffix('fr/../..')).toThrow();
  });

  it('accepts every suffix the writers actually build', () => {
    for (const ok of ['fr', 'en', 'und', 'fr.forced', 'en.hi']) {
      expect(() => assertSafeLangSuffix(ok)).not.toThrow();
    }
  });
});
