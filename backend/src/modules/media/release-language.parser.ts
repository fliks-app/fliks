import {
  SuitarrLanguageDefinition,
  ENGLISH_LANGUAGE,
  UNKNOWN_LANGUAGE,
  SUITARR_LANGUAGES,
} from '../../common/constants/suitarr-languages';

function norm(s: string): string {
  return s.replace(/[._\-]/g, ' ').toLowerCase();
}

/**
 * Infer release language from a torrent title.
 * Returns ENGLISH for untagged releases (standard assumption for English-language content).
 */
export function parseReleaseLanguage(title: string): SuitarrLanguageDefinition {
  const t = norm(title);

  // French markers (must check before generic patterns)
  if (/\b(french|vff|vfi|vf\b|truefrench|vostfr|vost)\b/.test(t))
    return lang('fr');

  // German
  if (/\b(german|deutsch)\b/.test(t)) return lang('de');

  // Spanish
  if (/\b(spanish|espanol|esp\b|spa\b|latino)\b/.test(t)) return lang('es');

  // Italian
  if (/\b(italian|italiano|ita\b)\b/.test(t)) return lang('it');

  // Portuguese
  if (/\b(portuguese|portugu[eê]s|pt[\- ]br|ptbr|por\b)\b/.test(t))
    return lang('pt');

  // Japanese
  if (/\b(japanese|japon[ae]s|jap\b|jpn\b)\b/.test(t)) return lang('ja');

  // Korean
  if (/\b(korean|cor[eé]en|kor\b)\b/.test(t)) return lang('ko');

  // Chinese
  if (/\b(chinese|chinois|chi\b|chn\b|mandarin|cantonese)\b/.test(t))
    return lang('zh');

  // Russian
  if (/\b(russian|russe|rus\b)\b/.test(t)) return lang('ru');

  // Arabic
  if (/\b(arabic|arabe|ara\b)\b/.test(t)) return lang('ar');

  // Dutch
  if (/\b(dutch|nl\b|nlx|flemish)\b/.test(t)) return lang('nl');

  // Polish
  if (/\b(polish|polonais|pol\b|pl\b)\b/.test(t)) return lang('pl');

  // Turkish
  if (/\b(turkish|turc|tur\b)\b/.test(t)) return lang('tr');

  // Swedish
  if (/\b(swedish|su[eè]dois|swe\b|sv\b)\b/.test(t)) return lang('sv');

  // Danish
  if (/\b(danish|danois|dan\b|dk\b)\b/.test(t)) return lang('da');

  // Norwegian
  if (/\b(norwegian|norv[eé]gien|nor\b|no\b)\b/.test(t)) return lang('no');

  // Finnish
  if (/\b(finnish|finlandais|fin\b)\b/.test(t)) return lang('fi');

  // MULTI / MULTi — treat as Unknown (multi-language)
  if (/\bmulti\b/.test(t)) return UNKNOWN_LANGUAGE;

  // Default: assume English (the vast majority of untagged releases are English)
  return ENGLISH_LANGUAGE;
}

function lang(isoCode: string): SuitarrLanguageDefinition {
  return (
    SUITARR_LANGUAGES.find((l) => l.isoCode === isoCode) ?? UNKNOWN_LANGUAGE
  );
}

/**
 * If parsed language is UNKNOWN and the indexer has an unknownLanguageIsoCode mapping,
 * remap to that language.
 */
export function resolveUnknownLanguage(
  parsed: SuitarrLanguageDefinition,
  unknownLanguageIsoCode: string | undefined,
): SuitarrLanguageDefinition {
  if (parsed.id !== UNKNOWN_LANGUAGE.id || !unknownLanguageIsoCode)
    return parsed;
  return (
    SUITARR_LANGUAGES.find((l) => l.isoCode === unknownLanguageIsoCode) ??
    parsed
  );
}
