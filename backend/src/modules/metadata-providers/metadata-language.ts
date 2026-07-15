/**
 * Curated languages the metadata providers (TMDB / TVDB) can fetch in, keyed by
 * ISO 639-1 code (the value stored in the `metadata_language` setting). Each
 * entry carries the per-provider dialect a call needs: TMDB's `lang-REGION`
 * locale, TVDB's ISO 639-2/T 3-letter code, and a region for release-date /
 * upcoming calls. Default is English.
 */
export interface MetadataLanguageOption {
  iso1: string;
  label: string;
  tmdbLocale: string;
  tvdbCode: string;
  region: string;
}

export const DEFAULT_METADATA_LANGUAGE = 'en';

export const METADATA_LANGUAGES: MetadataLanguageOption[] = [
  { iso1: 'en', label: 'English', tmdbLocale: 'en-US', tvdbCode: 'eng', region: 'US' },
  { iso1: 'fr', label: 'Français', tmdbLocale: 'fr-FR', tvdbCode: 'fra', region: 'FR' },
  { iso1: 'es', label: 'Español', tmdbLocale: 'es-ES', tvdbCode: 'spa', region: 'ES' },
  { iso1: 'de', label: 'Deutsch', tmdbLocale: 'de-DE', tvdbCode: 'deu', region: 'DE' },
  { iso1: 'it', label: 'Italiano', tmdbLocale: 'it-IT', tvdbCode: 'ita', region: 'IT' },
  { iso1: 'pt', label: 'Português', tmdbLocale: 'pt-PT', tvdbCode: 'por', region: 'PT' },
  { iso1: 'nl', label: 'Nederlands', tmdbLocale: 'nl-NL', tvdbCode: 'nld', region: 'NL' },
  { iso1: 'pl', label: 'Polski', tmdbLocale: 'pl-PL', tvdbCode: 'pol', region: 'PL' },
  { iso1: 'ru', label: 'Русский', tmdbLocale: 'ru-RU', tvdbCode: 'rus', region: 'RU' },
  { iso1: 'ja', label: '日本語', tmdbLocale: 'ja-JP', tvdbCode: 'jpn', region: 'JP' },
  { iso1: 'ko', label: '한국어', tmdbLocale: 'ko-KR', tvdbCode: 'kor', region: 'KR' },
  { iso1: 'zh', label: '中文', tmdbLocale: 'zh-CN', tvdbCode: 'zho', region: 'CN' },
];

/** Per-provider dialects resolved from the configured metadata language. */
export interface ResolvedMetadataLanguage {
  iso1: string;
  /** TMDB `language` param, e.g. `en-US`. */
  tmdbLocale: string;
  /** TMDB `include_image_language`, e.g. `fr,en,null` (`en,null` for English). */
  includeImageLanguage: string;
  /** ISO 639-1 code the logo picker biases toward. */
  logoIso1: string;
  /** TVDB translation code, e.g. `eng`. */
  tvdbCode: string;
  /** TMDB region for upcoming / now-playing. */
  region: string;
  /** Country priority for release-date extraction; `US` kept as fallback. */
  releaseDatePriority: string[];
}

/** Resolve a stored language code to its per-provider dialects, falling back to
 *  English for an unknown/empty value. */
export function resolveMetadataLanguage(
  code: string | null | undefined,
): ResolvedMetadataLanguage {
  const norm = (code ?? '').toLowerCase().split(/[-_]/)[0];
  const opt =
    METADATA_LANGUAGES.find((l) => l.iso1 === norm) ??
    METADATA_LANGUAGES.find((l) => l.iso1 === DEFAULT_METADATA_LANGUAGE)!;
  const includeImageLanguage = (
    opt.iso1 === 'en' ? [opt.iso1, 'null'] : [opt.iso1, 'en', 'null']
  ).join(',');
  const releaseDatePriority =
    opt.region === 'US' ? ['US'] : [opt.region, 'US'];
  return {
    iso1: opt.iso1,
    tmdbLocale: opt.tmdbLocale,
    includeImageLanguage,
    logoIso1: opt.iso1,
    tvdbCode: opt.tvdbCode,
    region: opt.region,
    releaseDatePriority,
  };
}
