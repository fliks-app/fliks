import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  viewChild,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { MediaDownloadProgress } from '../../../core/services/download-progress.service';
import { ProgressBarComponent } from '../progress-bar/progress-bar.component';
import {
  qbStateVariant,
  formatSpeed,
  formatEta,
  ProgressVariant,
} from '../../utils/download-format';

/**
 * Detail view behind the header download badge. The header badge shows only the
 * mean percent (a single chip can't faithfully represent several concurrent
 * season/pack downloads); opening this modal breaks that mean down into the
 * overall speed/ETA and a per-season progress list. The parent passes its live
 * `activeDownload()` so the modal keeps updating from SSE while it stays open.
 */
@Component({
  selector: 'app-download-detail-modal',
  standalone: true,
  imports: [TranslateModule, ProgressBarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './download-detail-modal.html',
})
export class DownloadDetailModalComponent {
  readonly progress = input<MediaDownloadProgress | null>(null);

  private readonly dialog =
    viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly overallVariant = computed<ProgressVariant>(() =>
    qbStateVariant(this.progress()?.state ?? ''),
  );
  readonly speedLabel = computed(() => {
    const d = this.progress();
    return d && d.dlspeed > 0 ? formatSpeed(d.dlspeed) : null;
  });
  readonly etaLabel = computed(() => {
    const d = this.progress();
    return d && d.eta > 0 ? formatEta(d.eta) : null;
  });

  /** Per-season rows for a series, sorted by season number. Empty for a movie
   *  or a series downloaded as one flat torrent. */
  readonly seasonRows = computed(() => {
    const seasons = this.progress()?.seasons;
    if (!seasons) return [];
    return [...seasons.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seasonNumber, v]) => ({
        seasonNumber,
        percent: v.percent,
        variant: qbStateVariant(v.state),
      }));
  });

  open(): void {
    this.dialog()?.nativeElement.showModal();
  }

  close(): void {
    this.dialog()?.nativeElement.close();
  }
}
