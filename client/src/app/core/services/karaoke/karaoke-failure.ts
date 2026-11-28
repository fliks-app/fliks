import type { TranslateService } from '@ngx-translate/core';
import type { KaraokeFailure } from '../api/karaoke.models';

/** The user-facing reason of a failed step, a code this client does not know read as `failed`; settings managers also get the server's `message`. */
export function failureText(translate: TranslateService, f: KaraokeFailure): string {
  const key = `karaoke.failure.${f.code}`;
  const known = translate.instant(key, f);
  const text = known === key ? translate.instant('karaoke.failure.failed') : known;
  return f.message ? `${text} ${f.message}` : text;
}
