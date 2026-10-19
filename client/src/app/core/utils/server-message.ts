import type { TranslateService } from '@ngx-translate/core';

/** What a server-supplied message should read as: a translation key (the API keeps user-facing copy English-only), an English sentence,
 *  or validation messages; an unknown key must not reach the user raw. */
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
