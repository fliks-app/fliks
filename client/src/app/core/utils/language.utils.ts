import { TranslateService } from '@ngx-translate/core';

/**
 * ISO 639-2 (3-letter B/T) → ISO 639-1 (2-letter) lookup. Mirrors the
 * server-side `ISO_639_2_TO_1` in `app-languages.ts` so the client can
 * normalise ffprobe-reported language codes (`eng`, `fra`, `chi`, …) into
 * the canonical 2-letter form used by our i18n keys (`language.en`,
 * `language.fr`, `language.zh`, …).
 */
const ISO_639_2_TO_1: Record<string, string> = {
  eng: 'en',
  fre: 'fr', fra: 'fr',
  ger: 'de', deu: 'de',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  jpn: 'ja',
  kor: 'ko',
  zho: 'zh', chi: 'zh',
  rus: 'ru',
  ara: 'ar',
  nld: 'nl', dut: 'nl',
  pol: 'pl',
  tur: 'tr',
  swe: 'sv',
  dan: 'da',
  nor: 'no',
  fin: 'fi',
  hin: 'hi',
  ces: 'cs', cze: 'cs',
  ron: 'ro', rum: 'ro',
  hun: 'hu',
  tha: 'th',
  vie: 'vi',
  heb: 'he',
  ell: 'el', gre: 'el',
  ukr: 'uk',
  bul: 'bg',
  hrv: 'hr',
  srp: 'sr',
  slv: 'sl',
  slk: 'sk', slo: 'sk',
  cat: 'ca',
  eus: 'eu', baq: 'eu',
  glg: 'gl',
  ind: 'id',
  msa: 'ms', may: 'ms',
};

/** Normalise a raw language code (any case, 2- or 3-letter) to ISO 639-1. */
export function normalizeLangCode(
  code: string | undefined | null,
): string {
  if (!code) return 'und';
  const lower = code.toLowerCase();
  return ISO_639_2_TO_1[lower] ?? lower;
}

/**
 * Best-effort language of a subtitle filename: `Movie.2020.fre.forced.srt` → `fr`.
 * Read right to left so a trailing language token wins over anything in the
 * title, and skip the extension and the leading video name.
 */
export function guessLanguageFromFilename(
  name: string,
  known: readonly string[],
): string | null {
  const tokens = name.split('.').slice(1, -1).reverse();
  for (const token of tokens) {
    const code = normalizeLangCode(token);
    if (known.includes(code)) return code;
  }
  return null;
}

/**
 * Resolve a language code to its translated display name (e.g. `fra` → `Français`).
 * Falls back to the normalised code when the translation key is missing or
 * the code is unknown — matches ffprobe's `und` placeholder so we don't
 * print "language.und" in the UI.
 */
export function localizeLanguage(
  code: string | undefined | null,
  translate: TranslateService,
): string {
  const norm = normalizeLangCode(code);
  if (norm === 'und' || norm === 'xx') return norm;
  const key = `language.${norm}`;
  const t = translate.instant(key);
  return typeof t === 'string' && t !== key ? t : norm;
}
