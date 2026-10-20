import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

/** Mirrors the backend's null-group placeholder (`group-name.ts`'s `UNGROUPED_SENTINEL`). */
const UNGROUPED_SENTINEL = '__livetv_ungrouped__';

/** Resolves a Live TV channel group name to its label; the backend sends a sentinel rather than an empty group, and the raw value is left untouched for API calls.
 *  Impure because translations load asynchronously and change with the locale. */
@Pipe({ name: 'liveTvGroupLabel', pure: false })
export class LiveTvGroupLabelPipe implements PipeTransform {
  private readonly translate = inject(TranslateService);

  transform(name: string | null | undefined): string {
    if (!name || name === UNGROUPED_SENTINEL) return this.translate.instant('liveTv.ungrouped');
    return name;
  }
}
