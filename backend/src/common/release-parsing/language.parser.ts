import {
  AppLanguageDefinition,
  ENGLISH_LANGUAGE,
  UNKNOWN_LANGUAGE,
  APP_LANGUAGES,
} from '../../common/constants/app-languages';

function norm(s: string): string {
  return s.replace(/[._\-]/g, ' ').toLowerCase();
}

/**
 * Infer release language from a torrent title.
 * Returns ENGLISH for untagged releases (standard assumption for English-language content).
 */
export function parseReleaseLanguage(title: string): AppLanguageDefinition {
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

function lang(isoCode: string): AppLanguageDefinition {
  return APP_LANGUAGES.find((l) => l.isoCode === isoCode) ?? UNKNOWN_LANGUAGE;
}

/**
 * Strict version of {@link parseReleaseLanguage} for stream / file
 * title fields (audio track titles like `"French AC3 5.1"`, subtitle
 * track titles like `"English SDH"`, etc.). Returns `null` when no
 * language keyword is recognised — unlike `parseReleaseLanguage`,
 * which defaults to English because the vast majority of untagged
 * torrent names ARE English. A muxer that omitted both the
 * `tags.language` and a language-naming `tags.title` shouldn't be
 * silently coerced to English: keep `und` so downstream auto-pick
 * logic can fall back to ordering / size heuristics instead.
 *
 * Returns the canonical ISO 639-2/B code (`'fre'`, `'eng'`, …) so
 * callers can drop it straight into ffprobe-shaped `language` fields.
 */
export function inferLanguageCodeFromTitle(
  title: string | null | undefined,
): string | null {
  if (!title) return null;
  const t = norm(title);
  if (/\b(french|francais|fran[cç]ais|vff|vfi|vf|truefrench|vostfr|vost)\b/.test(t))
    return 'fre';
  if (/\b(english|anglais|eng)\b/.test(t)) return 'eng';
  if (/\b(german|deutsch|allemand|ger\b|deu\b)\b/.test(t)) return 'ger';
  if (/\b(spanish|espanol|espa[nñ]ol|espagnol|esp\b|spa\b|latino)\b/.test(t))
    return 'spa';
  if (/\b(italian|italiano|italien|ita\b)\b/.test(t)) return 'ita';
  if (/\b(portuguese|portugu[eê]s|portugais|pt[\- ]br|ptbr|por\b)\b/.test(t))
    return 'por';
  if (/\b(japanese|japon[ae]s|japonais|jap\b|jpn\b)\b/.test(t)) return 'jpn';
  if (/\b(korean|cor[eé]en|kor\b)\b/.test(t)) return 'kor';
  if (/\b(chinese|chinois|chi\b|chn\b|mandarin|cantonese)\b/.test(t))
    return 'chi';
  if (/\b(russian|russe|rus\b)\b/.test(t)) return 'rus';
  if (/\b(arabic|arabe|ara\b)\b/.test(t)) return 'ara';
  if (/\b(dutch|n[ée]erlandais|n[ée]er\b|flemish|nld\b|dut\b)\b/.test(t))
    return 'dut';
  if (/\b(polish|polonais|pol\b)\b/.test(t)) return 'pol';
  if (/\b(turkish|turc|tur\b)\b/.test(t)) return 'tur';
  if (/\b(swedish|su[eè]dois|swe\b)\b/.test(t)) return 'swe';
  if (/\b(danish|danois|dan\b)\b/.test(t)) return 'dan';
  if (/\b(norwegian|norv[eé]gien|nor\b)\b/.test(t)) return 'nor';
  if (/\b(finnish|finlandais|fin\b)\b/.test(t)) return 'fin';
  if (/\b(hindi|hin\b)\b/.test(t)) return 'hin';
  if (/\b(czech|tch[eè]que|ces\b|cze\b)\b/.test(t)) return 'cze';
  if (/\b(romanian|roumain|ron\b|rum\b)\b/.test(t)) return 'rum';
  if (/\b(hungarian|hongrois|hun\b)\b/.test(t)) return 'hun';
  if (/\b(thai|thai[ée]?landais|tha\b)\b/.test(t)) return 'tha';
  if (/\b(vietnamese|vietnamien|vie\b)\b/.test(t)) return 'vie';
  if (/\b(hebrew|h[eé]breu|heb\b)\b/.test(t)) return 'heb';
  if (/\b(greek|grec|ell\b|gre\b)\b/.test(t)) return 'gre';
  if (/\b(ukrainian|ukrainien|ukr\b)\b/.test(t)) return 'ukr';
  if (/\b(indonesian|indon[eé]sien|ind\b)\b/.test(t)) return 'ind';
  return null;
}

/**
 * If parsed language is UNKNOWN and the indexer has an unknownLanguageIsoCode mapping,
 * remap to that language.
 */
export function resolveUnknownLanguage(
  parsed: AppLanguageDefinition,
  unknownLanguageIsoCode: string | undefined,
): AppLanguageDefinition {
  if (parsed.id !== UNKNOWN_LANGUAGE.id || !unknownLanguageIsoCode)
    return parsed;
  return (
    APP_LANGUAGES.find((l) => l.isoCode === unknownLanguageIsoCode) ?? parsed
  );
}
