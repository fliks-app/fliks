/**
 * ISO 639-1 codes offered as subtitle translation targets. Mirrors the backend
 * `APP_LANGUAGES` set (minus the "unknown" xx entry). Labels are rendered
 * through the {@link LocalizeLanguagePipe}, so only the codes live here.
 */
export const SUBTITLE_LANGUAGE_CODES: readonly string[] = [
  'en', 'fr', 'de', 'es', 'it', 'pt', 'ja', 'ko', 'zh', 'ru',
  'ar', 'nl', 'pl', 'tr', 'sv', 'da', 'no', 'fi', 'hi', 'cs',
  'ro', 'hu', 'th', 'vi', 'he', 'el', 'uk', 'bg', 'hr', 'sr',
  'sl', 'sk', 'ca', 'eu', 'gl', 'id', 'ms',
];
