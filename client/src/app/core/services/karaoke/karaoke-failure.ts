import type { TranslateService } from '@ngx-translate/core';
import type { KaraokeFailure } from '../api/karaoke.models';

/** The user-facing reason of a failed step; the server's own `message` follows it for settings managers. */
export function failureText(translate: TranslateService, f: KaraokeFailure): string {
  const key = `karaoke.failure.${f.code}`;
  const text = translate.instant(key, f);
  return f.message ? `${text} ${f.message}` : text;
}
