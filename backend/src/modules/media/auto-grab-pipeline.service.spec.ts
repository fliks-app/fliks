import { AutoGrabPipelineService } from './auto-grab-pipeline.service';
import { Media } from './entities/media.entity';

describe('AutoGrabPipelineService.shouldSearchMissing', () => {
  const service = Object.create(
    AutoGrabPipelineService.prototype,
  ) as AutoGrabPipelineService;

  const profile = {
    cutoff: 16, // WEBDL-1080p rank 62
    upgradeAllowed: true,
    items: [],
  };

  const media = {
    qualityProfile: profile,
    languageProfile: { audioLanguages: [] },
  } as unknown as Media;

  it('returns true when there is no file on disk', () => {
    expect(service.shouldSearchMissing(media, [])).toBe(true);
  });

  it('returns false when the file is already at cutoff', () => {
    expect(
      service.shouldSearchMissing(media, [{ quality: 'WEBDL-1080p' }]),
    ).toBe(false);
  });

  it('returns true when upgrade is allowed and the file is below cutoff', () => {
    expect(
      service.shouldSearchMissing(media, [{ quality: 'HDTV-720p' }]),
    ).toBe(true);
  });

  it('returns false when upgrades are disabled and a file exists', () => {
    const noUpgrade = {
      ...media,
      qualityProfile: { ...profile, upgradeAllowed: false },
    } as unknown as Media;
    expect(
      service.shouldSearchMissing(noUpgrade, [{ quality: 'HDTV-720p' }]),
    ).toBe(false);
  });
});

describe('AutoGrabPipelineService.classifyForSearch — "skip" still carries ranked bounds', () => {
  const service = Object.create(
    AutoGrabPipelineService.prototype,
  ) as AutoGrabPipelineService;

  const profile = {
    cutoff: 16, // WEBDL-1080p rank 62
    upgradeAllowed: true,
    items: [],
  };

  const media = {
    qualityProfile: profile,
    languageProfile: { audioLanguages: [] },
  } as unknown as Media;

  it('carries the current/cutoff rank when the file already meets cutoff', () => {
    expect(
      service.classifyForSearch(media, [{ quality: 'WEBDL-1080p' }]),
    ).toEqual({ mode: 'skip', minRankExclusive: 62, maxRankInclusive: 62, skipReason: 'at-cutoff' });
  });

  it('carries the current/cutoff rank when upgrades are disabled, even below cutoff', () => {
    const noUpgrade = {
      ...media,
      qualityProfile: { ...profile, upgradeAllowed: false },
    } as unknown as Media;
    expect(
      service.classifyForSearch(noUpgrade, [{ quality: 'HDTV-720p' }]),
    ).toEqual({ mode: 'skip', minRankExclusive: 40, maxRankInclusive: 62, skipReason: 'upgrades-disabled' });
  });

  it('still returns "unprofiled" with no rank data when a profile is missing', () => {
    const unprofiled = { qualityProfile: null, languageProfile: null } as unknown as Media;
    expect(service.classifyForSearch(unprofiled, [])).toEqual({
      mode: 'unprofiled',
    });
  });
});

describe('AutoGrabPipelineService.searchExclusionReason', () => {
  const service = Object.create(AutoGrabPipelineService.prototype) as AutoGrabPipelineService;
  const profile = { cutoff: 16, upgradeAllowed: true, items: [] };
  const media = { qualityProfile: profile, languageProfile: { audioLanguages: [] } } as unknown as Media;

  it('VERDICT: names which of the three routes to skip was taken', () => {
    expect(service.searchExclusionReason(media, [{ quality: 'WEBDL-1080p' }])).toBe('at-cutoff');

    const noUpgrade = { ...media, qualityProfile: { ...profile, upgradeAllowed: false } } as unknown as Media;
    expect(service.searchExclusionReason(noUpgrade, [{ quality: 'HDTV-720p' }])).toBe('upgrades-disabled');

    const noCutoff = { ...media, qualityProfile: { ...profile, cutoff: 99_999 } } as unknown as Media;
    expect(service.searchExclusionReason(noCutoff, [{ quality: 'HDTV-720p' }])).toBe('no-cutoff-configured');

    const unprofiled = { qualityProfile: null, languageProfile: null } as unknown as Media;
    expect(service.searchExclusionReason(unprofiled, [])).toBe('unprofiled');
  });

  it('returns null for a row that does need a search, so it is never counted as excluded', () => {
    expect(service.searchExclusionReason(media, [])).toBeNull();
    expect(service.searchExclusionReason(media, [{ quality: 'HDTV-720p' }])).toBeNull();
  });
});
