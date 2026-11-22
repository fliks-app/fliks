import type { TranslateService } from '@ngx-translate/core';

/** Optional top-level fields of an API error body, next to `message`. */
export interface ServerErrorKey {
  key?: string;
  params?: Record<string, unknown>;
}

/** What a server-supplied message should read as: a translation key (the API keeps user-facing copy English-only), an English sentence,
 *  or validation messages; an unknown key must not reach the user raw. */
export function translatedServerMessage(
  message: unknown,
  translate: TranslateService,
  body?: ServerErrorKey | null,
): string | null {
  if (typeof body?.key === 'string' && body.key) {
    const byKey = translate.instant(body.key, body.params);
    if (byKey !== body.key) return byKey;
  }
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
  const body = (err as { error?: { message?: unknown } & ServerErrorKey })?.error;
  return (
    translatedServerMessage(body?.message, translate, body) ??
    pluginErrorMessage(body, translate) ??
    translate.instant(fallbackKey)
  );
}

/** A plugin route answers `{error:{key,detail}}`; its keys are merged into the catalogue on install. */
export function pluginErrorMessage(body: unknown, translate: TranslateService): string | null {
  const e = (body as { error?: { key?: unknown; detail?: unknown } } | null | undefined)?.error;
  if (typeof e?.key !== 'string' || !e.key) return null;
  const translated = translate.instant(e.key, { detail: e.detail });
  if (translated !== e.key) return translated;
  return typeof e.detail === 'string' && e.detail ? e.detail : null;
}
