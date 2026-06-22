import { SubtitleStatus } from '../enums';
import {
  hasServableTextSub,
  isImageBasedSubtitleCodec,
} from './subtitle-codecs';

describe('isImageBasedSubtitleCodec', () => {
  it('flags bitmap codecs and nothing else', () => {
    expect(isImageBasedSubtitleCodec('hdmv_pgs_subtitle')).toBe(true);
    expect(isImageBasedSubtitleCodec('dvd_subtitle')).toBe(true);
    expect(isImageBasedSubtitleCodec('subrip')).toBe(false);
    expect(isImageBasedSubtitleCodec(null)).toBe(false);
  });
});

describe('hasServableTextSub', () => {
  it('treats a text subtitle as satisfying the language', () => {
    const subs = [
      { language: 'fr', codec: 'subrip', status: SubtitleStatus.DOWNLOADED },
    ];
    expect(hasServableTextSub(subs, 'fr')).toBe(true);
  });

  it('does not let an image-based track satisfy the language', () => {
    const subs = [
      {
        language: 'fr',
        codec: 'hdmv_pgs_subtitle',
        status: SubtitleStatus.EMBEDDED,
      },
    ];
    expect(hasServableTextSub(subs, 'fr')).toBe(false);
  });

  it('ignores failed text rows', () => {
    const subs = [
      { language: 'fr', codec: 'subrip', status: SubtitleStatus.FAILED },
    ];
    expect(hasServableTextSub(subs, 'fr')).toBe(false);
  });

  it('counts an in-progress OCR (text) row as covering the language', () => {
    const subs = [
      { language: 'fr', codec: 'subrip', status: SubtitleStatus.PROCESSING },
    ];
    expect(hasServableTextSub(subs, 'fr')).toBe(true);
  });

  it('matches only the requested language', () => {
    const subs = [
      { language: 'en', codec: 'subrip', status: SubtitleStatus.DOWNLOADED },
    ];
    expect(hasServableTextSub(subs, 'fr')).toBe(false);
  });
});
