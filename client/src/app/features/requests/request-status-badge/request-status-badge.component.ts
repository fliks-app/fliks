import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ProgressBadgeComponent } from '../../../shared/components/progress-badge/progress-badge.component';
import { DownloadProgressService } from '../../../core/services/download-progress.service';
import {
  FliksRequestRow,
  FliksRequestStatus,
} from '../../../core/services/api/requests.service';

/**
 * Status badge for a request row, shared by the requests list and the home
 * request card so the label, colour and live download percent are computed in
 * one place. An approved/processing request with an in-flight download reads as
 * "downloading" (with the mean percent, per-season requests averaging only
 * their requested seasons); otherwise it tracks the media's monitored state.
 * Other statuses (pending, declined, available…) read as their status label.
 */
@Component({
  selector: 'app-request-status-badge',
  standalone: true,
  imports: [TranslateModule, ProgressBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Transparent to layout so the inner badge stays the flex item it replaced.
  host: { class: 'contents' },
  templateUrl: './request-status-badge.component.html',
})
export class RequestStatusBadgeComponent {
  private readonly downloadProgress = inject(DownloadProgressService);

  readonly request = input.required<FliksRequestRow>();

  readonly percent = computed<number | null>(() => {
    const r = this.request();
    if (r.status !== 'approved' && r.status !== 'processing') return null;
    if (!r.media?.monitored) return null;
    const id = r.media?.id;
    if (id == null) return null;
    const p = this.downloadProgress.progress().get(id);
    if (!p) return null;
    if (r.seasons?.length && p.seasons) {
      const vals = r.seasons
        .map((s) => p.seasons!.get(s)?.percent)
        .filter((x): x is number => x != null);
      if (!vals.length) return null;
      return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }
    return p.percent;
  });

  readonly labelKey = computed<string>(() => {
    const r = this.request();
    if (r.status === 'approved' || r.status === 'processing') {
      if (this.percent() !== null) return 'requests.badge_downloading';
      return r.media?.monitored
        ? 'requests.badge_monitored'
        : 'requests.badge_unmonitored';
    }
    return 'requests.status.' + r.status;
  });

  readonly badgeClass = computed<string>(() => {
    const r = this.request();
    if (r.status === 'approved' || r.status === 'processing') {
      return r.media?.monitored ? 'badge-info' : 'badge-ghost';
    }
    return this.statusBadgeClass(r.status);
  });

  private statusBadgeClass(status: FliksRequestStatus): string {
    switch (status) {
      case 'pending':
        return 'badge-warning';
      case 'approved':
      case 'available':
        return 'badge-success';
      case 'declined':
      case 'failed':
        return 'badge-error';
      case 'processing':
        return 'badge-info';
      default:
        return 'badge-ghost';
    }
  }
}
