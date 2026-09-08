import { localizeLanguage, sortByLanguageName } from './language.utils';
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
