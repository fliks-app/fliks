import { SubtitlesService } from './subtitles.service';

/**
 * Names are parsed right to left, so a `hi` token is only Hindi until a real
 * language token turns up further left. Fliks writes `.fr.hi.srt` itself, so
 * getting this wrong mislabels the files it produced.
 */
describe('SubtitlesService.parseSubtitleFilename', () => {
  const parse = (name: string) =>
    (SubtitlesService.prototype as never as {
      parseSubtitleFilename: (n: string) => Record<string, unknown> | null;
    }).parseSubtitleFilename.call(
      { resolveLanguageCode: (t: string) =>
          ['fr', 'en', 'hi', 'es'].includes(t) ? t : null },
      name,
    );

  it('VERDICT: a hi token left of a language is the HI flag, not Hindi', () => {
    expect(parse('Movie.en.hi.srt')).toMatchObject({
      language: 'en',
      hearingImpaired: true,
      hiPart: 2,
    });
  });

  it('keeps a lone hi as Hindi', () => {
    expect(parse('Movie.hi.srt')).toMatchObject({
      language: 'hi',
      hearingImpaired: false,
    });
  });

  it('reads every flag of a name Fliks wrote itself', () => {
    expect(parse('Movie.fr.hi.forced.srt')).toMatchObject({
      language: 'fr',
      forced: true,
      hearingImpaired: true,
    });
  });

  it('steps over its own .ocr marker to reach the language', () => {
    expect(parse('Movie.fr.ocr.srt')).toMatchObject({ language: 'fr' });
  });

  it('ignores non-subtitle extensions', () => {
    expect(parse('Movie.fr.mkv')).toBeNull();
  });
});
