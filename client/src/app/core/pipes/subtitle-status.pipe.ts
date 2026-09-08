import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

/** Every label already shipped for these states, wherever it lives. */
const STATUS_KEYS: Record<string, string> = {
  downloaded: 'activity.status_downloaded',
  upgraded: 'activity.status_upgraded',
  synced: 'activity.status_synced',
  failed: 'activity.status_failed',
  processing: 'requests.status.processing',
  embedded: 'media_detail.embedded',
  missing: 'media_detail.subtitle_missing',
};

/**
 * Resolve a subtitle row's stored status to its display label. An unmapped
 * status falls through to its raw value rather than an empty cell.
 *
 * Impure because the translation table loads asynchronously and changes when
 * the user switches locale.
 */
@Pipe({ name: 'subtitleStatus', pure: false })
export class SubtitleStatusPipe implements PipeTransform {
  private readonly translate = inject(TranslateService);

  transform(status: string | null | undefined): string {
    if (!status) return '';
    const key = STATUS_KEYS[status];
    return key ? this.translate.instant(key) : status;
  }
}
