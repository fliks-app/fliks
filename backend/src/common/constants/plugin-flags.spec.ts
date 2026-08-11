import {
  FLIKS_BUNDLES_ENV,
  isBundleEnabled,
  isDownloadBundleEnabled,
} from './plugin-flags';

describe('isBundleEnabled / isDownloadBundleEnabled', () => {
  const original = process.env[FLIKS_BUNDLES_ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[FLIKS_BUNDLES_ENV];
    else process.env[FLIKS_BUNDLES_ENV] = original;
  });

  it('loads every bundle when unset — preserves today\'s default', () => {
    delete process.env[FLIKS_BUNDLES_ENV];
    expect(isDownloadBundleEnabled()).toBe(true);
  });

  it('loads no bundle for an empty string', () => {
    process.env[FLIKS_BUNDLES_ENV] = '';
    expect(isDownloadBundleEnabled()).toBe(false);
  });

  it('loads the download bundle when it is named', () => {
    process.env[FLIKS_BUNDLES_ENV] = 'download';
    expect(isDownloadBundleEnabled()).toBe(true);
  });

  it('drops a bundle absent from a non-empty list', () => {
    process.env[FLIKS_BUNDLES_ENV] = 'some-other-bundle';
    expect(isDownloadBundleEnabled()).toBe(false);
  });

  it('trims ids and drops empties, same as FLIKS_UNSIGNED_PLUGINS', () => {
    process.env[FLIKS_BUNDLES_ENV] = ' download , , other ';
    expect(isBundleEnabled('download')).toBe(true);
    expect(isBundleEnabled('other')).toBe(true);
    expect(isBundleEnabled('')).toBe(false);
  });
});
