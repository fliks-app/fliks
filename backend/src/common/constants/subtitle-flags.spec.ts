import {
  matchesRequestedFlags,
  prefersHearingImpaired,
  requestFlagsOf,
  subtitleFlagsFromTitle,
} from './subtitle-flags';
import { SubtitleLanguageItem } from './subtitle-flags';

const item = (over: Partial<SubtitleLanguageItem> = {}): SubtitleLanguageItem =>
  ({ isoCode: 'fr', name: 'French', forced: false, hi: false, ...over }) as SubtitleLanguageItem;

describe('matchesRequestedFlags', () => {
  it('VERDICT: forced is exact in both directions', () => {
    const req = requestFlagsOf(item());
    expect(matchesRequestedFlags({ forced: false }, req)).toBe(true);
    expect(matchesRequestedFlags({ forced: true }, req)).toBe(false);

    const forcedReq = requestFlagsOf(item({ forced: true }));
    expect(matchesRequestedFlags({ forced: true }, forcedReq)).toBe(true);
    expect(matchesRequestedFlags({ forced: false }, forcedReq)).toBe(false);
  });

  it('VERDICT: an unstated forced constrains nothing (hand-driven search)', () => {
    // the manual search modal passes no flags: it must still see forced results
    expect(matchesRequestedFlags({ forced: true }, {})).toBe(true);
    expect(matchesRequestedFlags({ forced: false }, {})).toBe(true);
    // a profile item always states one, even when stored without the key
    expect(requestFlagsOf({ isoCode: 'fr' } as SubtitleLanguageItem).forced).toBe(false);
  });

  it('treats null/undefined flags as false rather than dropping the candidate', () => {
    expect(matchesRequestedFlags({}, requestFlagsOf(item()))).toBe(true);
    expect(matchesRequestedFlags({ forced: null }, requestFlagsOf(item()))).toBe(true);
  });

  it('only require/forbid filter on HI; prefer/avoid just order', () => {
    const hi = { forced: false, hearingImpaired: true };
    expect(matchesRequestedFlags(hi, requestFlagsOf(item({ hearingImpaired: 'require' })))).toBe(true);
    expect(matchesRequestedFlags(hi, requestFlagsOf(item({ hearingImpaired: 'forbid' })))).toBe(false);
    expect(matchesRequestedFlags(hi, requestFlagsOf(item()))).toBe(true);
    expect(matchesRequestedFlags(hi, requestFlagsOf(item({ hi: true })))).toBe(true);

    expect(prefersHearingImpaired(requestFlagsOf(item({ hi: true })))).toBe(true);
    expect(prefersHearingImpaired(requestFlagsOf(item()))).toBe(false);
  });
});

describe('subtitleFlagsFromTitle', () => {
  it('reads flags a muxer only put in the stream title', () => {
    expect(subtitleFlagsFromTitle('Français (Forced)').forced).toBe(true);
    expect(subtitleFlagsFromTitle('English Foreign Parts Only').forced).toBe(true);
    expect(subtitleFlagsFromTitle('English SDH').hearingImpaired).toBe(true);
    expect(subtitleFlagsFromTitle('English (closed captions)').hearingImpaired).toBe(true);
  });

  it('does not invent flags on a plain title', () => {
    expect(subtitleFlagsFromTitle('Français')).toEqual({ forced: false, hearingImpaired: false });
    expect(subtitleFlagsFromTitle(null)).toEqual({ forced: false, hearingImpaired: false });
    // a bare "hi" in a title is Hindi far more often than hearing-impaired
    expect(subtitleFlagsFromTitle('Hindi').hearingImpaired).toBe(false);
    // substrings must not trigger: "unenforced", "accent"
    expect(subtitleFlagsFromTitle('Unenforced').forced).toBe(false);
    expect(subtitleFlagsFromTitle('Accented').hearingImpaired).toBe(false);
  });
});
