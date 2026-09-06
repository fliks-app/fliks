import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  viewChild,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MediaDownloadProgress } from '../../../core/services/download-progress.service';
import { ProgressBarComponent } from '../progress-bar/progress-bar.component';
import { ModalHeaderComponent } from '../modal-header';
import {
  qbStateVariant,
  qbStateLabelKey,
  formatSpeed,
  formatEta,
  ProgressVariant,
} from '../../utils/download-format';
import { ModalFooterComponent } from '../modal-footer';

interface LeafRow {
  key: string;
  labelKey: string;
  labelNumber: number | null;
  /** Null while the release is still being searched for — there is no download
   *  to be a percentage of yet. */
  percent: number | null;
  variant: ProgressVariant;
  /** Always stated: "searching" and "stalled" are the two a row most needs to
   *  explain itself, and neither shows up in a bar or a percentage. */
  stateLabelKey: string;
  speed: string | null;
  eta: string | null;
}

interface SeasonRow {
  seasonNumber: number;
  /** One row per download. The season itself carries no folded status: with
   *  concurrent episodes it could only ever be a rollup that contradicts the
   *  rows under it. */
  leaves: LeafRow[];
}

/**
 * Detail view behind the header / request download badge. The badge can only
 * fold several concurrent downloads into one chip; this modal is where they come
 * apart — one bar, speed and ETA per download, under the season it belongs to.
 * No rollup above them: with concurrent episodes it could only ever be an
 * aggregate that contradicts the rows beneath it. A movie has a single download
 * and no season dimension, so it keeps a single headline instead.
 *
 * The parent passes its live `progress` so the modal keeps updating from SSE
 * while it stays open.
 */
@Component({
  selector: 'app-download-detail-modal',
  standalone: true,
  imports: [ModalFooterComponent, TranslatePipe, ProgressBarComponent, ModalHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './download-detail-modal.html',
})
export class DownloadDetailModalComponent {
  readonly progress = input<MediaDownloadProgress | null>(null);

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  /** A movie's single download: no season to group under, so it is its own row. */
  readonly isSingleDownload = computed(() => !this.progress()?.seasons);

  readonly overallStateLabelKey = computed(() =>
    qbStateLabelKey(this.progress()?.state ?? ''),
  );

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

  readonly seasonRows = computed<SeasonRow[]>(() => {
    const seasons = this.progress()?.seasons;
    if (!seasons) return [];
    return [...seasons.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seasonNumber, sp]) => ({
        seasonNumber,
        leaves: [...sp.leaves.entries()]
          .sort((a, b) => this.leafOrder(a[1]) - this.leafOrder(b[1]))
          .map(([key, l]) => ({
            key: String(key),
            ...this.leafLabel(l.episodeNumber),
            percent: l.state === 'searching' ? null : l.percent,
            variant: qbStateVariant(l.state),
            stateLabelKey: qbStateLabelKey(l.state),
            speed: l.dlspeed && l.dlspeed > 0 ? formatSpeed(l.dlspeed) : null,
            eta: l.eta && l.eta > 0 ? formatEta(l.eta) : null,
          })),
      }));
  });

  private leafLabel(episodeNumber?: number): { labelKey: string; labelNumber: number | null } {
    if (episodeNumber != null) {
      return { labelKey: 'tracking.episode', labelNumber: episodeNumber };
    }
    return { labelKey: 'media_detail.download_pack', labelNumber: null };
  }

  /** Episode order, packs last. The key identifies the download now, so it says
   *  nothing about where the row belongs in the list. */
  private leafOrder(leaf: { episodeNumber?: number }): number {
    return leaf.episodeNumber ?? Number.MAX_SAFE_INTEGER;
  }

  open(): void {
    this.dialog()?.nativeElement.showModal();
  }

  close(): void {
    this.dialog()?.nativeElement.close();
  }
}
