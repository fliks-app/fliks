import { TranslateService } from '@ngx-translate/core';
import { SUBTITLE_LANGUAGE_CODES } from '../constants/subtitle-languages';
import { ISO_639_2_TO_1_FULL } from './iso-639-2';

/**
 * Codes folded after the ISO 639-2 → 639-1 step: deprecated tags, the 3-letter forms
 * players report for macro-languages, and Norwegian (the app's lists only know `no`,
 * so `nb`/`nn` match it). Same table on the backend (`app-languages.ts`).
 */
const FOLDED_CODES: Readonly<Record<string, string>> = {
  iw: 'he', in: 'id', ji: 'yi', mo: 'ro', jw: 'jv', tw: 'ak',
  nb: 'no', nn: 'no',
  cmn: 'zh', arb: 'ar', twi: 'ak', scc: 'sr', scr: 'hr',
  // Media3 macro-language tags (`hbs-hrv`, `ms-ind`) carry the language in the 2nd subtag.
  'hbs-hrv': 'hr', 'hbs-srp': 'sr', 'hbs-bos': 'bs', 'ms-ind': 'id',
};

/**
 * Canonical form of a language tag, whoever reported it: lowercase ISO 639-1 when the
 * language has one, else the 639-2/3 code; region/script subtags dropped; `und` if empty.
 */
export function normalizeLangCode(
  code: string | undefined | null,
): string {
  const [primary, second] = (code ?? '').trim().toLowerCase().split(/[-_]/);
  if (!primary) return 'und';
  const macro = FOLDED_CODES[`${primary}-${second}`];
  if (macro) return macro;
  const iso1 = ISO_639_2_TO_1_FULL[primary] ?? primary;
  return FOLDED_CODES[iso1] ?? iso1;
}

export interface SubtitleTags {
  language: string | null;
  forced: boolean;
  hearingImpaired: boolean;
}

const FORCED_TOKENS = new Set(['forced', 'foreign']);
const HI_TOKENS = new Set(['hi', 'cc', 'sdh']);

/**
 * Language and flags of a subtitle filename (`Movie.en.hi.srt` → en, hearing-impaired).
 * Same right-to-left rules as the backend `parseSubtitleFilename`: the leftmost part is the
 * video name, a lone `hi` is Hindi, and the walk stops at the first unrecognised token.
 */
export function guessSubtitleTags(name: string, known: readonly string[] = SUBTITLE_LANGUAGE_CODES): SubtitleTags {
  const tags: SubtitleTags = { language: null, forced: false, hearingImpaired: false };
  let hiCandidate = false;
  for (const raw of name.split('.').slice(1, -1).reverse()) {
    const token = raw.toLowerCase();
    if (FORCED_TOKENS.has(token)) {
      tags.forced = true;
    } else if (HI_TOKENS.has(token)) {
      if (token === 'hi' && tags.language === null) {
        tags.language = 'hi';
        hiCandidate = true;
      } else {
        tags.hearingImpaired = true;
      }
    } else if (token === 'default' || token === 'ocr') {
      continue;
    } else {
      const code = normalizeLangCode(token);
      if (!known.includes(code)) break;
      tags.language = code;
      if (hiCandidate) {
        tags.hearingImpaired = true;
        hiCandidate = false;
      }
    }
  }
  return tags;
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
  if (typeof t === 'string' && t !== key) return t;
  const locale = translate.currentLang() || translate.fallbackLang() || 'en';
  return nativeLanguageName(norm, locale) ?? norm;
}

const displayNames = new Map<string, Intl.DisplayNames | null>();

/**
 * The platform's own name for a language code we carry no translation for
 * (`est`, `tam`, …), in the UI locale. Null when the runtime has no
 * `Intl.DisplayNames` (Chromium < 81, i.e. the TV builds) or the code is
 * unknown to it — the caller then shows the raw code.
 */
function nativeLanguageName(code: string, locale: string): string | null {
  if (typeof Intl.DisplayNames !== 'function') return null;
  if (!displayNames.has(locale)) {
    try {
      displayNames.set(locale, new Intl.DisplayNames([locale], { type: 'language' }));
    } catch {
      displayNames.set(locale, null);
    }
  }
  let name: string | undefined;
  try {
    name = displayNames.get(locale)?.of(code);
  } catch {
    return null;
  }
  if (!name || name === code) return null;
  // Our own names are capitalised; several locales render theirs lowercase.
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
}

/**
 * Track lists ordered by their displayed language name. Entries whose code has
 * no known name (`und`, `xx`, an untranslated code) go last, in source order;
 * the sort is stable, so same-language renditions keep their source order too.
 */
export function sortByLanguageName<T extends { language?: string }>(
  items: readonly T[],
  translate: TranslateService,
): T[] {
  const name = (i: T) => localizeLanguage(i.language, translate);
  const unnamed = (i: T) => (name(i) === normalizeLangCode(i.language) ? 1 : 0);
  return [...items].sort(
    (a, b) =>
      unnamed(a) - unnamed(b) ||
      (unnamed(a) ? 0 : name(a).localeCompare(name(b))),
  );
}
