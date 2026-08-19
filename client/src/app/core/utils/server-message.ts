import type { TranslateService } from '@ngx-translate/core';

/**
 * What a server-supplied message should read as. A backend may answer a translation key
 * (the English-only rule keeps user-facing copy out of the API), an English sentence, or
 * an array of validation messages. An unknown key would otherwise reach the user raw.
 */
export function translatedServerMessage(
  message: unknown,
  translate: TranslateService,
): string | null {
  if (Array.isArray(message)) return message.join(', ');
  if (typeof message !== 'string' || !message) return null;
  const translated = translate.instant(message);
  return translated !== message ? translated : message;
}

/** The same rule for a component holding an `HttpErrorResponse`, with its own fallback key. */
export function serverMessage(
  err: unknown,
  translate: TranslateService,
  fallbackKey: string,
): string {
  const body = (err as { error?: { message?: unknown } })?.error;
  return translatedServerMessage(body?.message, translate) ?? translate.instant(fallbackKey);
}
