import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AcquisitionApiService, type AcquisitionHistoryRow } from '../../../../core/services/api/acquisition-api.service';
import { LocaleDatePipe } from '../../../../core/pipes/locale-date.pipe';
import { AuthService } from '../../../../core/services/auth.service';
import { SseService } from '../../../../core/services/sse.service';
import { TvService } from '../../../../core/services/tv.service';
import { DetailSectionComponent } from '../../../../shared/components/detail-section/detail-section';
import { STATE_LABELS } from '../../../acquisition-queue/acquisition-queue.config';

const ROWS = 5;

const STATE_BADGES: Record<string, string> = {
  active: 'badge-info',
  stalled: 'badge-warning',
  importing: 'badge-primary',
  import_failed: 'badge-error',
  imported: 'badge-success',
  failed: 'badge-error',
};

/** The last grabs of a title, folded; nothing for a viewer who cannot open the queue history, on TV, or while the title has none. */
@Component({
  selector: 'app-media-downloads',
  imports: [RouterLink, TranslatePipe, LocaleDatePipe, DetailSectionComponent],
  templateUrl: './media-downloads.component.html',
  host: { '[class.hidden]': '!rows().length' },
})
export class MediaDownloadsComponent {
  private readonly api = inject(AcquisitionApiService);
  private readonly auth = inject(AuthService);
  private readonly tv = inject(TvService);

  readonly mediaId = input.required<number>();

  protected readonly rows = signal<AcquisitionHistoryRow[]>([]);
  protected readonly stateLabels = STATE_LABELS;
  private readonly allowed = computed(() => !this.tv.isTv() && this.auth.hasPermission('media.grab'));

  constructor() {
    effect(() => {
      const id = this.mediaId();
      if (this.allowed()) untracked(() => void this.load(id));
    });
    inject(SseService).on('queue.updated').pipe(takeUntilDestroyed()).subscribe(() => {
      if (this.allowed()) void this.load(this.mediaId());
    });
  }

  protected badge(state: string): string {
    return STATE_BADGES[state] ?? 'badge-ghost';
  }

  private async load(id: number): Promise<void> {
    try {
      const rows = await this.api.history(id, ROWS);
      if (id === this.mediaId()) this.rows.set(rows);
    } catch {
      // The panel is a hint: a failed read leaves it as it was.
    }
  }
}
