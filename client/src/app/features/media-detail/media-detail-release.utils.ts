import { TranslateService } from '@ngx-translate/core';
import type { MovieRelease } from './media-detail-release-picker.service';

export function formatReleaseRejection(
  translate: TranslateService,
  r: { code: string; params?: Record<string, number | string> },
): string {
  const key = `media_detail.rejection.${r.code}`;
  const translated = translate.instant(key, r.params);
  return translated !== key ? translated : r.code;
}

/** The plugin reports a title with no quality/language profile as a 409 carrying
 *  this key (mirrors `download.grab.errors.unprofiled` on the grab route). */
export function isUnprofiledReleaseError(err: unknown): boolean {
  const body = (err as { error?: { error?: { key?: string } } })?.error?.error;
  return body?.key === 'download.grab.errors.unprofiled';
}

/** A release outside the profile can still be grabbed by hand — `force` tells the
 *  plugin to skip the allowed-quality guard it enforces for an unattended grab. */
export function releaseGrabBody(r: MovieRelease): { downloadUrl: string; sourceTitle: string; sourceId: number; force?: true } {
  return {
    downloadUrl: r.downloadUrl,
    sourceTitle: r.title,
    sourceId: r.sourceId,
    ...(r.allowed ? {} : { force: true }),
  };
}
