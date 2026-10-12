import { guessSubtitleTags, localizeLanguage, normalizeLangCode, sortByLanguageName } from './language.utils';
import { signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { buildSubtitleTracks } from './subtitle-tracks';

const NAMES: Record<string, string> = {
  'language.fr': 'Français',
  'language.en': 'Anglais',
  'language.de': 'Allemand',
};
const translate = {
  instant: (key: string) => NAMES[key] ?? key,
  currentLang: signal('fr'),
  fallbackLang: signal('en'),
} as unknown as TranslateService;

describe('sortByLanguageName', () => {
  it('sorts by name and pushes unnamed tracks last', () => {
    const sorted = sortByLanguageName(
      [
        { id: 'a', language: 'und' },
        { id: 'b', language: 'fre' },
        { id: 'c', language: 'qaa' },
        { id: 'd', language: 'deu' },
        { id: 'e', language: 'eng' },
      ],
      translate,
    );
    expect(sorted.map((t) => t.id)).toEqual(['d', 'e', 'b', 'a', 'c']);
  });

  it('keeps same-language renditions in source order', () => {
    const sorted = sortByLanguageName(
      [{ id: '5.1', language: 'fr' }, { id: 'stereo', language: 'fr' }],
      translate,
    );
    expect(sorted.map((t) => t.id)).toEqual(['5.1', 'stereo']);
  });
});

describe('localizeLanguage', () => {
  it('names a code the app carries no translation for', () => {
    const bare = {
      instant: (key: string) => key,
      currentLang: signal('fr'),
      fallbackLang: signal('en'),
    } as unknown as TranslateService;
    expect(localizeLanguage('est', bare)).toBe('Estonien');
    expect(localizeLanguage('tam', bare)).toBe('Tamoul');
  });

  it('keeps the raw code for a private-use tag', () => {
    const bare = {
      instant: (key: string) => key,
      currentLang: signal('en'),
      fallbackLang: signal('en'),
    } as unknown as TranslateService;
    expect(localizeLanguage('qaa', bare)).toBe('qaa');
    expect(localizeLanguage(undefined, bare)).toBe('und');
  });

  it('prefers our own translation over the platform name', () => {
    const translate = {
      instant: (key: string) => (key === 'language.fr' ? 'Français' : key),
      currentLang: signal('en'),
      fallbackLang: signal('en'),
    } as unknown as TranslateService;
    expect(localizeLanguage('fre', translate)).toBe('Français');
  });
});

/** Every subtitle list in the app goes through this builder, and every
 *  comparison downstream assumes it hands back canonical ISO 639-1. */
describe('buildSubtitleTracks language canonicalisation', () => {
  const row = (id: number, language: string) => ({
    id,
    mediaFileId: 1,
    language,
    relativePath: `/${id}.srt`,
  });

  it('folds every code form a source can carry', () => {
    const tracks = buildSubtitleTracks(
      [row(1, 'fre'), row(2, 'fra'), row(3, 'FR'), row(4, 'fr'), row(5, 'chi')],
      1,
      { hideBurnIn: false },
    );
    expect(tracks.map((t) => t.language)).toEqual(['fr', 'fr', 'fr', 'fr', 'zh']);
  });

  it('keeps the placeholder for an untagged track', () => {
    expect(buildSubtitleTracks([row(1, '')], 1, { hideBurnIn: false })[0].language).toBe('und');
  });
});

describe('normalizeLangCode', () => {
  it.each([
    ['eng', 'en'], ['fre', 'fr'], ['fra', 'fr'], ['est', 'et'], ['isl', 'is'], ['ice', 'is'],
    ['per', 'fa'], ['fas', 'fa'], ['tam', 'ta'], ['lav', 'lv'], ['lit', 'lt'], ['hrv', 'hr'],
  ])('maps the ISO 639-2 code %s to %s', (input, expected) => {
    expect(normalizeLangCode(input)).toBe(expected);
  });

  it.each([
    ['fr-FR', 'fr'], ['pt-BR', 'pt'], ['zh_Hans_CN', 'zh'], ['EN', 'en'], [' Fre ', 'fr'],
  ])('strips subtags and case from %s', (input, expected) => {
    expect(normalizeLangCode(input)).toBe(expected);
  });

  it.each([
    ['hbs-hrv', 'hr'], ['hbs-srp', 'sr'], ['hbs-bos', 'bs'], ['ms-ind', 'id'], ['no-nob', 'no'],
    ['scc', 'sr'], ['cmn', 'zh'], ['arb', 'ar'], ['twi', 'ak'], ['tw', 'ak'], ['iw', 'he'], ['in', 'id'],
    ['ji', 'yi'], ['mo', 'ro'],
  ])('folds the player alias %s to %s', (input, expected) => {
    expect(normalizeLangCode(input)).toBe(expected);
  });

  it('folds Norwegian variants to the single `no` the app lists know', () => {
    for (const code of ['nor', 'nob', 'nno', 'nb', 'nn', 'nb-NO']) {
      expect(normalizeLangCode(code)).toBe('no');
    }
  });

  it('returns und for an empty tag and keeps codes without a 639-1 form', () => {
    for (const empty of ['', '  ', null, undefined, '-']) {
      expect(normalizeLangCode(empty)).toBe('und');
    }
    expect(normalizeLangCode('yue')).toBe('yue');
  });

  it('matches what each player reports against what the app stores', () => {
    const same = (engine: string, stored: string) =>
      normalizeLangCode(engine) === normalizeLangCode(stored);
    expect(same('et', 'est')).toBe(true);
    expect(same('hbs-hrv', 'hr')).toBe(true);
    expect(same('hbs-hrv', 'hrv')).toBe(true);
    expect(same('pt-BR', 'pt')).toBe(true);
    expect(same('ms-ind', 'ind')).toBe(true);
    expect(same('no-nob', 'nor')).toBe(true);
    expect(same('et', 'fr')).toBe(false);
  });
});

describe('guessSubtitleTags', () => {
  it('reads 3-letter and regional language tokens', () => {
    expect(guessSubtitleTags('Movie.fra.srt').language).toBe('fr');
    expect(guessSubtitleTags('Movie.pt-BR.srt').language).toBe('pt');
    expect(guessSubtitleTags('Movie.nob.srt').language).toBe('no');
  });
});
