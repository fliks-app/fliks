/**
 * Curated languages + regions the metadata providers (TMDB / TVDB) can fetch in.
 * The language (ISO 639-1) drives title/overview/genre localization + the TVDB
 * translation code; the region (ISO 3166-1) drives TMDB release dates + upcoming.
 * Both are configurable globally (`metadata_language` / `metadata_region`
 * settings) and can be overridden per library. Defaults: English / US.
 */
export interface MetadataLanguageOption {
  iso1: string;
  label: string;
  tvdbCode: string;
  /** Region used when none is configured (so a bare language still localizes). */
  defaultRegion: string;
}

export interface MetadataRegionOption {
  code: string;
  label: string;
}

export const DEFAULT_METADATA_LANGUAGE = 'en';
export const DEFAULT_METADATA_REGION = 'US';

export const METADATA_LANGUAGES: MetadataLanguageOption[] = [
  { iso1: 'en', label: 'English', tvdbCode: 'eng', defaultRegion: 'US' },
  { iso1: 'fr', label: 'Français', tvdbCode: 'fra', defaultRegion: 'FR' },
  { iso1: 'es', label: 'Español', tvdbCode: 'spa', defaultRegion: 'ES' },
  { iso1: 'de', label: 'Deutsch', tvdbCode: 'deu', defaultRegion: 'DE' },
  { iso1: 'it', label: 'Italiano', tvdbCode: 'ita', defaultRegion: 'IT' },
  { iso1: 'pt', label: 'Português', tvdbCode: 'por', defaultRegion: 'PT' },
  { iso1: 'nl', label: 'Nederlands', tvdbCode: 'nld', defaultRegion: 'NL' },
  { iso1: 'pl', label: 'Polski', tvdbCode: 'pol', defaultRegion: 'PL' },
  { iso1: 'ru', label: 'Русский', tvdbCode: 'rus', defaultRegion: 'RU' },
  { iso1: 'ja', label: '日本語', tvdbCode: 'jpn', defaultRegion: 'JP' },
  { iso1: 'ko', label: '한국어', tvdbCode: 'kor', defaultRegion: 'KR' },
  { iso1: 'zh', label: '中文', tvdbCode: 'zho', defaultRegion: 'CN' },
];

export const METADATA_REGIONS: MetadataRegionOption[] = [
  { code: 'US', label: 'United States' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'FR', label: 'France' },
  { code: 'DE', label: 'Germany' },
  { code: 'ES', label: 'Spain' },
  { code: 'IT', label: 'Italy' },
  { code: 'PT', label: 'Portugal' },
  { code: 'BR', label: 'Brazil' },
  { code: 'NL', label: 'Netherlands' },
  { code: 'PL', label: 'Poland' },
  { code: 'RU', label: 'Russia' },
  { code: 'JP', label: 'Japan' },
  { code: 'KR', label: 'South Korea' },
  { code: 'CN', label: 'China' },
  { code: 'CA', label: 'Canada' },
  { code: 'AU', label: 'Australia' },
  { code: 'MX', label: 'Mexico' },
  { code: 'IN', label: 'India' },
];

/** Per-provider dialects resolved from the configured language + region. */
export interface ResolvedMetadataLanguage {
  iso1: string;
  /** TMDB `language` param, e.g. `en-US` (language + region). */
  tmdbLocale: string;
  /** TMDB `include_image_language`, e.g. `fr,en,null` (`en,null` for English). */
  includeImageLanguage: string;
  /** ISO 639-1 code the logo picker biases toward. */
  logoIso1: string;
  /** TVDB translation code, e.g. `eng`. */
  tvdbCode: string;
  /** TMDB region for upcoming / now-playing / release dates. */
  region: string;
  /** Country priority for release-date extraction; `US` kept as fallback. */
  releaseDatePriority: string[];
}

/** Resolve a stored language + region to their per-provider dialects. Unknown/
 *  empty language falls back to English; empty region falls back to the
 *  language's default region. */
export function resolveMetadataLanguage(
  languageCode: string | null | undefined,
  regionCode: string | null | undefined,
): ResolvedMetadataLanguage {
  const langNorm = (languageCode ?? '').toLowerCase().split(/[-_]/)[0];
  const opt =
    METADATA_LANGUAGES.find((l) => l.iso1 === langNorm) ??
    METADATA_LANGUAGES.find((l) => l.iso1 === DEFAULT_METADATA_LANGUAGE)!;
  const region = (regionCode ?? '').toUpperCase() || opt.defaultRegion;
  const includeImageLanguage = (
    opt.iso1 === 'en' ? [opt.iso1, 'null'] : [opt.iso1, 'en', 'null']
  ).join(',');
  const releaseDatePriority = region === 'US' ? ['US'] : [region, 'US'];
  return {
    iso1: opt.iso1,
    tmdbLocale: `${opt.iso1}-${region}`,
    includeImageLanguage,
    logoIso1: opt.iso1,
    tvdbCode: opt.tvdbCode,
    region,
    releaseDatePriority,
  };
}
