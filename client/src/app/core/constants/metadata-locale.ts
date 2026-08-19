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
const METADATA_REGION_CODES = [
  'US',
  'GB',
  'FR',
  'DE',
  'ES',
  'IT',
  'PT',
  'BR',
  'NL',
  'PL',
  'RU',
  'JP',
  'KR',
  'CN',
  'CA',
  'AU',
  'MX',
  'IN',
] as const;

/** Region names come from the platform (`Intl.DisplayNames`) so they follow the
 *  UI language instead of shipping 18 names × 6 locales. */
export function metadataRegionOptions(lang: string): MetadataLocaleOption[] {
  let display: Intl.DisplayNames | null = null;
  try {
    display = new Intl.DisplayNames([lang || 'en'], { type: 'region' });
  } catch {
    /* unsupported locale data — fall back to the raw code */
  }
  return METADATA_REGION_CODES.map((code) => ({
    code,
    label: display?.of(code) ?? code,
  }));
}
