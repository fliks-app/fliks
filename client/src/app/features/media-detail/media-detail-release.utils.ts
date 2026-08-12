import { TranslateService } from '@ngx-translate/core';

export function formatReleaseRejection(
  translate: TranslateService,
  r: { code: string; params?: Record<string, number | string> },
): string {
  const key = `media_detail.rejection.${r.code}`;
  const translated = translate.instant(key, r.params);
  return translated !== key ? translated : r.code;
}
