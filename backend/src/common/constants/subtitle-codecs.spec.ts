import { SubtitleStatus } from '../enums';
import { SubtitleLanguageItem } from '../../modules/profiles/entities/language-profile.entity';
import {
  hasCoveringSub,
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

const want = (over: Partial<SubtitleLanguageItem> = {}): SubtitleLanguageItem =>
  ({ isoCode: 'fr', name: 'French', forced: false, hi: false, ...over }) as SubtitleLanguageItem;

describe('hasCoveringSub', () => {
  it('treats a text subtitle as satisfying the language', () => {
    const subs = [
      { language: 'fr', codec: 'subrip', status: SubtitleStatus.DOWNLOADED },
    ];
    expect(hasCoveringSub(subs, want())).toBe(true);
  });

  it('does not let an image-based track satisfy the language', () => {
    const subs = [
      {
        language: 'fr',
        codec: 'hdmv_pgs_subtitle',
        status: SubtitleStatus.EMBEDDED,
      },
    ];
    expect(hasCoveringSub(subs, want())).toBe(false);
  });

  it('ignores failed text rows', () => {
    const subs = [
      { language: 'fr', codec: 'subrip', status: SubtitleStatus.FAILED },
    ];
    expect(hasCoveringSub(subs, want())).toBe(false);
  });

  it('counts an in-progress OCR (text) row as covering the language', () => {
    const subs = [
      { language: 'fr', codec: 'subrip', status: SubtitleStatus.PROCESSING },
    ];
    expect(hasCoveringSub(subs, want())).toBe(true);
  });

  it('does not let a forced track cover a full-subtitle request', () => {
    const subs = [
      { language: 'fr', forced: true, codec: 'subrip', status: SubtitleStatus.DOWNLOADED },
    ];
    expect(hasCoveringSub(subs, want())).toBe(false);
    expect(hasCoveringSub(subs, want({ forced: true }))).toBe(true);
  });

  it('does not let a full subtitle cover a forced request', () => {
    const subs = [
      { language: 'fr', forced: false, codec: 'subrip', status: SubtitleStatus.DOWNLOADED },
    ];
    expect(hasCoveringSub(subs, want({ forced: true }))).toBe(false);
  });

  it('VERDICT: coverage ignores the HI mode entirely', () => {
    const hi = [
      { language: 'fr', hearingImpaired: true, codec: 'subrip', status: SubtitleStatus.DOWNLOADED },
    ];
    const plain = [
      { language: 'fr', hearingImpaired: false, codec: 'subrip', status: SubtitleStatus.DOWNLOADED },
    ];

    // The HI mode picks what to fetch. Enforcing it here re-fetches forever
    // when `subtitle_remove_hi_tags` clears the flag the profile requires.
    for (const mode of ['prefer', 'avoid', 'require', 'forbid'] as const) {
      expect(hasCoveringSub(hi, want({ hearingImpaired: mode }))).toBe(true);
      expect(hasCoveringSub(plain, want({ hearingImpaired: mode }))).toBe(true);
    }
  });

  it('counts an image track only when burn-in is accepted', () => {
    const subs = [
      { language: 'fr', codec: 'hdmv_pgs_subtitle', status: SubtitleStatus.EMBEDDED },
    ];
    expect(hasCoveringSub(subs, want(), { imageTracksCount: true })).toBe(true);
    expect(hasCoveringSub(subs, want(), { imageTracksCount: false })).toBe(false);
  });

  it('matches only the requested language', () => {
    const subs = [
      { language: 'en', codec: 'subrip', status: SubtitleStatus.DOWNLOADED },
    ];
    expect(hasCoveringSub(subs, want())).toBe(false);
  });
});
