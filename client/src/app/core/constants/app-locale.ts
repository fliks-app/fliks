/** UI languages the app ships translations for. `code` is the ISO 639-1 tag and
 *  the i18n filename (`i18n/<code>.json`); `label` is the language's own name. */
export interface AppLocale {
  code: string;
  label: string;
}

export const SUPPORTED_LOCALES: AppLocale[] = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
];

/** Used when the browser/OS language isn't one we ship. */
export const DEFAULT_LOCALE = 'en';

export const SUPPORTED_LOCALE_CODES = SUPPORTED_LOCALES.map((l) => l.code);

/** Fold a BCP-47 / ISO tag (e.g. `fr-FR`, `en_US`) to a supported code, or null. */
export function normalizeToSupportedLocale(
  tag: string | null | undefined,
): string | null {
  if (!tag) return null;
  const base = tag.toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LOCALE_CODES.includes(base) ? base : null;
}

/**
 * Resolve the initial UI language synchronously (used by both LOCALE_ID and
 * ngx-translate at bootstrap): the user's explicit override wins, else the
 * first browser/OS language we support (navigator.languages reflects the OS
 * language in Capacitor + Smart-TV WebViews too), else the default (English).
 * Reads localStorage directly so it needs no DI at config time.
 */
export function resolveInitialLocale(): string {
  try {
    const raw = localStorage.getItem('display.settings');
    const override = raw
      ? (JSON.parse(raw) as { language?: string }).language
      : '';
    if (override && SUPPORTED_LOCALE_CODES.includes(override)) return override;
  } catch {
    /* private mode / SSR */
  }
  const tags =
    typeof navigator !== 'undefined'
      ? navigator.languages?.length
        ? navigator.languages
        : [navigator.language]
      : [];
  for (const tag of tags) {
    const match = normalizeToSupportedLocale(tag);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}
