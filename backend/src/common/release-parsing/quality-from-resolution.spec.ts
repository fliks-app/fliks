import { qualityFromResolution } from './quality-from-resolution';

describe('qualityFromResolution', () => {
  it('buckets by real pixels, ignoring a mislabeled release resolution', () => {
    // Release name claims 2160p, but the file is a 1080p scope master (1920×804).
    expect(
      qualityFromResolution('The.Fall.Guy.2024.2160p.WEB-DL.x265', 1920, 804),
    ).toBe('WEBDL-1080p');
  });

  it('keeps 2160p when the pixels really are 2160p', () => {
    expect(
      qualityFromResolution('Movie.2024.2160p.WEB-DL', 3840, 2160),
    ).toBe('WEBDL-2160p');
  });

  it('takes the source tag from the text (remux)', () => {
    expect(qualityFromResolution('Movie.2024.1080p.Remux', 1920, 1080)).toBe(
      'Remux-1080p',
    );
  });

  it('defaults the source to hdtv when no tag is present', () => {
    expect(qualityFromResolution('Movie 2024 1080', 1920, 1080)).toBe(
      'HDTV-1080p',
    );
  });
});
