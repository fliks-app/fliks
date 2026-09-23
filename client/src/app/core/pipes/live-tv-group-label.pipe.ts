import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

/** Mirrors the backend's null-group placeholder (`group-name.ts`'s `UNGROUPED_SENTINEL`). */
const UNGROUPED_SENTINEL = '__livetv_ungrouped__';

/**
 * Resolves a Live TV channel group name to its display label. The backend
 * never sends a null/empty group, it sends the sentinel instead — this pipe
 * is the one place that turns it back into a translated label; the raw value
 * (sentinel or real name) is left untouched for anything sent back to the API.
 *
 * Impure because the translation table loads asynchronously and changes when
 * the user switches locale.
 */
@Pipe({ name: 'liveTvGroupLabel', pure: false })
export class LiveTvGroupLabelPipe implements PipeTransform {
  private readonly translate = inject(TranslateService);

  transform(name: string | null | undefined): string {
    if (!name || name === UNGROUPED_SENTINEL) return this.translate.instant('liveTv.ungrouped');
    return name;
  }
}
