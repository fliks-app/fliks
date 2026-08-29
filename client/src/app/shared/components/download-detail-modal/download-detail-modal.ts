import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  viewChild,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { LeafKey, MediaDownloadProgress } from '../../../core/services/download-progress.service';
import { ProgressBarComponent } from '../progress-bar/progress-bar.component';
import { ModalHeaderComponent } from '../modal-header';
import {
  qbStateVariant,
  qbStateLabelKey,
  foldLeaves,
  formatSpeed,
  formatEta,
  ProgressVariant,
} from '../../utils/download-format';
import { ModalFooterComponent } from '../modal-footer';

interface LeafRow {
  key: string;
  labelKey: string;
  labelNumber: number | null;
  percent: number;
  variant: ProgressVariant;
  stateLabelKey: string;
}

interface SeasonRow {
  seasonNumber: number;
  percent: number | null;
  variant: ProgressVariant;
  stateLabelKey: string;
  /** Per-torrent rows. Empty only for a season whose single leaf is a pack —
   *  that one restates the season line above it. */
  leaves: LeafRow[];
}

/**
 * Detail view behind the header / request download badge. The badge shows the
 * folded status + mean percent (a single chip can't convey several concurrent
 * season/episode torrents); this modal breaks that down into the overall
 * speed/ETA, a per-season status, and — when a season has several torrents —
 * a per-episode list. The parent passes its live `progress` so the modal keeps
 * updating from SSE while it stays open.
 */
@Component({
  selector: 'app-download-detail-modal',
  standalone: true,
  imports: [ModalFooterComponent, TranslateModule, ProgressBarComponent, ModalHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './download-detail-modal.html',
})
export class DownloadDetailModalComponent {
  readonly progress = input<MediaDownloadProgress | null>(null);

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly overallStateLabelKey = computed(() => qbStateLabelKey(this.progress()?.state ?? ''));
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
      .map(([seasonNumber, sp]) => {
        const entries = [...sp.leaves.entries()];
        const fold = foldLeaves(entries.map(([, l]) => l));
        const leaves = entries
          .sort((a, b) => this.leafOrder(a[0]) - this.leafOrder(b[0]))
          .map(([key, l]) => ({
            key: String(key),
            ...this.leafLabel(key),
            percent: l.percent,
            variant: qbStateVariant(l.state),
            stateLabelKey: qbStateLabelKey(l.state),
          }));
        return {
          seasonNumber,
          percent: fold.percent,
          variant: qbStateVariant(fold.state),
          stateLabelKey: qbStateLabelKey(fold.state),
          // A lone season pack restates the season line; a lone episode does
          // not — without its row the modal never says which one is downloading.
          leaves:
            leaves.length === 1 && leaves[0].labelNumber === null ? [] : leaves,
        };
      });
  });

  private leafLabel(key: LeafKey): { labelKey: string; labelNumber: number | null } {
    if (typeof key === 'number') {
      return { labelKey: 'tracking.episode', labelNumber: key };
    }
    return { labelKey: 'media_detail.download_pack', labelNumber: null };
  }

  private leafOrder(key: LeafKey): number {
    return typeof key === 'number' ? key : Number.MAX_SAFE_INTEGER;
  }

  open(): void {
    this.dialog()?.nativeElement.showModal();
  }

  close(): void {
    this.dialog()?.nativeElement.close();
  }
}
