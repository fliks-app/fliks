export interface MetadataLocaleOption {
  code: string;
  label: string;
}

/** Languages the metadata providers can fetch in (ISO 639-1). Labels are endonyms. */
export const METADATA_LANGUAGE_OPTIONS: readonly MetadataLocaleOption[] = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'ru', label: 'Русский' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '中文' },
];

/** Regions driving release dates / upcoming (ISO 3166-1). */
export const METADATA_REGION_OPTIONS: readonly MetadataLocaleOption[] = [
  { code: 'US', label: 'États-Unis' },
  { code: 'GB', label: 'Royaume-Uni' },
  { code: 'FR', label: 'France' },
  { code: 'DE', label: 'Allemagne' },
  { code: 'ES', label: 'Espagne' },
  { code: 'IT', label: 'Italie' },
  { code: 'PT', label: 'Portugal' },
  { code: 'BR', label: 'Brésil' },
  { code: 'NL', label: 'Pays-Bas' },
  { code: 'PL', label: 'Pologne' },
  { code: 'RU', label: 'Russie' },
  { code: 'JP', label: 'Japon' },
  { code: 'KR', label: 'Corée du Sud' },
  { code: 'CN', label: 'Chine' },
  { code: 'CA', label: 'Canada' },
  { code: 'AU', label: 'Australie' },
  { code: 'MX', label: 'Mexique' },
  { code: 'IN', label: 'Inde' },
];
