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
    } as Media;
    expect(
      service.shouldSearchMissing(noUpgrade, [{ quality: 'HDTV-720p' }]),
    ).toBe(false);
  });
});
