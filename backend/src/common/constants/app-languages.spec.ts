import { normalizeLanguageCode } from './app-languages';

describe('normalizeLanguageCode', () => {
  it.each([
    ['eng', 'en'],
    ['fre', 'fr'],
    ['fra', 'fr'],
    ['est', 'et'],
    ['isl', 'is'],
    ['ice', 'is'],
    ['per', 'fa'],
    ['fas', 'fa'],
    ['tam', 'ta'],
    ['lav', 'lv'],
    ['lit', 'lt'],
    ['hrv', 'hr'],
  ])('maps the ISO 639-2 code %s to %s', (input, expected) => {
    expect(normalizeLanguageCode(input)).toBe(expected);
  });

  it.each([
    ['fr-FR', 'fr'],
    ['pt-BR', 'pt'],
    ['zh_Hans_CN', 'zh'],
    ['EN', 'en'],
    [' Fre ', 'fr'],
  ])('strips subtags and case from %s', (input, expected) => {
    expect(normalizeLanguageCode(input)).toBe(expected);
  });

  it.each([
    ['hbs-hrv', 'hr'],
    ['hbs-srp', 'sr'],
    ['hbs-bos', 'bs'],
    ['ms-ind', 'id'],
    ['no-nob', 'no'],
    ['scc', 'sr'],
    ['cmn', 'zh'],
    ['arb', 'ar'],
    ['twi', 'ak'],
    ['tw', 'ak'],
    ['iw', 'he'],
    ['in', 'id'],
    ['ji', 'yi'],
    ['mo', 'ro'],
  ])('folds the player alias %s to %s', (input, expected) => {
    expect(normalizeLanguageCode(input)).toBe(expected);
  });

  it('folds Norwegian variants to the single `no` the app lists know', () => {
    for (const code of ['nor', 'nob', 'nno', 'nb', 'nn', 'nb-NO']) {
      expect(normalizeLanguageCode(code)).toBe('no');
    }
  });

  it('returns und for an empty tag and keeps codes without a 639-1 form', () => {
    for (const empty of ['', '  ', null, undefined, '-']) {
      expect(normalizeLanguageCode(empty)).toBe('und');
    }
    expect(normalizeLanguageCode('yue')).toBe('yue');
  });
});
