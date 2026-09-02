import { localizeLanguage, sortByLanguageName } from './language.utils';
import { TranslateService } from '@ngx-translate/core';

const NAMES: Record<string, string> = {
  'language.fr': 'Français',
  'language.en': 'Anglais',
  'language.de': 'Allemand',
};
const translate = { instant: (key: string) => NAMES[key] ?? key } as TranslateService;

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
    const bare = { instant: (key: string) => key, currentLang: 'fr' } as TranslateService;
    expect(localizeLanguage('est', bare)).toBe('Estonien');
    expect(localizeLanguage('tam', bare)).toBe('Tamoul');
  });

  it('keeps the raw code for a private-use tag', () => {
    const bare = { instant: (key: string) => key, currentLang: 'en' } as TranslateService;
    expect(localizeLanguage('qaa', bare)).toBe('qaa');
    expect(localizeLanguage(undefined, bare)).toBe('und');
  });

  it('prefers our own translation over the platform name', () => {
    const translate = {
      instant: (key: string) => (key === 'language.fr' ? 'Français' : key),
      currentLang: 'en',
    } as TranslateService;
    expect(localizeLanguage('fre', translate)).toBe('Français');
  });
});
