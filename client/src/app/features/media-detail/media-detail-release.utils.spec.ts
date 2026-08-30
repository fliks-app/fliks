import { isUnprofiledReleaseError, releaseGrabBody } from './media-detail-release.utils';
import type { MovieRelease } from './media-detail-release-picker.service';

function makeRelease(overrides: Partial<MovieRelease> = {}): MovieRelease {
  return {
    title: 'Placeholder.Title.2020.1080p',
    downloadUrl: 'magnet:placeholder',
    qualityId: 3,
    qualityName: '1080p',
    rank: 30,
    allowed: true,
    customFormatScore: 0,
    blocklisted: false,
    sourceId: 1,
    sourceName: 'indexer',
    languageId: 1,
    languageName: 'English',
    languageAllowed: true,
    size: 1_000_000,
    seeders: 5,
    leechers: 1,
    rejections: [],
    freeleech: false,
    downloadVolumeFactor: 1,
    isFullSeason: false,
    sizeDeviation: null,
    videoCodec: null,
    ...overrides,
  };
}

describe('releaseGrabBody', () => {
  it('sends no force field for an allowed release', () => {
    const body = releaseGrabBody(makeRelease({ allowed: true }));
    expect('force' in body).toBe(false);
  });

  it('sends force: true for a rejected release', () => {
    const body = releaseGrabBody(makeRelease({ allowed: false }));
    expect(body.force).toBe(true);
  });
});

describe('isUnprofiledReleaseError', () => {
  it('matches the plugin\'s unprofiled error shape', () => {
    const err = { error: { error: { key: 'download.grab.errors.unprofiled' } } };
    expect(isUnprofiledReleaseError(err)).toBe(true);
  });

  it('does not match an unrelated error', () => {
    expect(isUnprofiledReleaseError({ error: { error: { key: 'download.grab.errors.blocklisted' } } })).toBe(false);
    expect(isUnprofiledReleaseError(new Error('network'))).toBe(false);
    expect(isUnprofiledReleaseError(undefined)).toBe(false);
  });
});

describe('releaseGrabBody — the tracker page', () => {
  it('VERDICT: echoes the search hit back, since the grab route cannot derive it from downloadUrl', () => {
    const body = releaseGrabBody(makeRelease({ infoUrl: 'https://tracker.example/details/42' }));
    expect(body.infoUrl).toBe('https://tracker.example/details/42');
  });

  it('sends no key at all for a hit whose feed named no page', () => {
    expect('infoUrl' in releaseGrabBody(makeRelease({}))).toBe(false);
  });
});
