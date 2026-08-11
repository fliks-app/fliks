import { isJobAvailable } from './scheduler.service';
import { FLIKS_BUNDLES_ENV } from '../../common/constants/plugin-flags';

describe('isJobAvailable', () => {
  const DOWNLOAD_BUNDLE_JOBS = [
    'SearchMissing',
    'RssSync',
    'ImportCompleted',
    'CleanStalled',
    'CleanSeeded',
  ];
  const CORE_JOBS = ['RefreshMetadata', 'SubtitleSearch', 'SubtitleUpgrade'];

  it('offers every download-bundle job when the bundle is enabled', () => {
    for (const name of DOWNLOAD_BUNDLE_JOBS) {
      expect(isJobAvailable(name, true)).toBe(true);
    }
  });

  it('drops every download-bundle job when the bundle is disabled', () => {
    for (const name of DOWNLOAD_BUNDLE_JOBS) {
      expect(isJobAvailable(name, false)).toBe(false);
    }
  });

  it('never drops a job the download bundle does not own', () => {
    for (const name of CORE_JOBS) {
      expect(isJobAvailable(name, true)).toBe(true);
      expect(isJobAvailable(name, false)).toBe(true);
    }
  });

  describe('default parameter — reads FLIKS_BUNDLES at call time', () => {
    const original = process.env[FLIKS_BUNDLES_ENV];

    afterEach(() => {
      if (original === undefined) delete process.env[FLIKS_BUNDLES_ENV];
      else process.env[FLIKS_BUNDLES_ENV] = original;
    });

    it('follows the env var when no explicit flag is passed', () => {
      process.env[FLIKS_BUNDLES_ENV] = '';
      expect(isJobAvailable('SearchMissing')).toBe(false);
      delete process.env[FLIKS_BUNDLES_ENV];
      expect(isJobAvailable('SearchMissing')).toBe(true);
    });
  });
});
