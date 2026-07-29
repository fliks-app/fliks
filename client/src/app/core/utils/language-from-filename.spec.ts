import { guessLanguageFromFilename } from './language.utils';

const KNOWN = ['en', 'fr', 'de', 'es', 'pt'];

describe('guessLanguageFromFilename', () => {
  it('reads a two-letter token', () => {
    expect(guessLanguageFromFilename('Movie.2020.fr.srt', KNOWN)).toBe('fr');
  });

  it('normalises a three-letter token', () => {
    expect(guessLanguageFromFilename('Movie.2020.fre.srt', KNOWN)).toBe('fr');
  });

  it('takes the rightmost language token', () => {
    expect(guessLanguageFromFilename('The.En.Show.2020.de.srt', KNOWN)).toBe('de');
  });

  it('skips flag tokens', () => {
    expect(guessLanguageFromFilename('Movie.es.forced.srt', KNOWN)).toBe('es');
  });

  it('returns null when nothing matches', () => {
    expect(guessLanguageFromFilename('subtitle.srt', KNOWN)).toBeNull();
    expect(guessLanguageFromFilename('Movie.2020.1080p.srt', KNOWN)).toBeNull();
  });
});
