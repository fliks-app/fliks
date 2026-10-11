import { guessSubtitleTags } from './language.utils';

const tags = (language: string | null, forced = false, hearingImpaired = false) => ({
  language,
  forced,
  hearingImpaired,
});

describe('guessSubtitleTags', () => {
  it('reads two- and three-letter language tokens', () => {
    expect(guessSubtitleTags('Movie.2020.fr.srt')).toEqual(tags('fr'));
    expect(guessSubtitleTags('Movie.2020.fre.srt')).toEqual(tags('fr'));
  });

  it('takes the rightmost language token and stops at the title', () => {
    expect(guessSubtitleTags('The.En.Show.2020.de.srt')).toEqual(tags('de'));
  });

  it('reads hi before a language as hearing-impaired', () => {
    expect(guessSubtitleTags('Film.en.hi.srt')).toEqual(tags('en', false, true));
  });

  it('reads a lone hi as Hindi', () => {
    expect(guessSubtitleTags('Film.hi.srt')).toEqual(tags('hi'));
  });

  it('reads forced and sdh flags', () => {
    expect(guessSubtitleTags('Film.fr.forced.srt')).toEqual(tags('fr', true));
    expect(guessSubtitleTags('Film.en.sdh.srt')).toEqual(tags('en', false, true));
  });

  it('returns no language when nothing matches', () => {
    expect(guessSubtitleTags('subtitle.srt')).toEqual(tags(null));
    expect(guessSubtitleTags('Movie.2020.1080p.srt')).toEqual(tags(null));
  });
});
