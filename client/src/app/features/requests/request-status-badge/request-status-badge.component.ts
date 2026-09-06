import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ProgressBadgeComponent } from '../../../shared/components/progress-badge/progress-badge.component';
import { DownloadProgressService } from '../../../core/services/download-progress.service';
import {
  describeBadge,
  DownloadBadgeDescriptor,
} from '../../../shared/utils/download-format';
import { TvService } from '../../../core/services/tv.service';
import {
  FliksRequestRow,
  FliksRequestStatus,
} from '../../../core/services/api/requests.service';

/**
 * Status badge for a request row, shared by the requests list and the home
 * request card. Composes two concerns:
 *  - request **lifecycle** states (pending / declined / available / failed) →
 *    `requests.status.*`, owned here;
 *  - for an in-flight approved/processing request, the real **download** status
 *    (downloading / stalled / queued / paused / error…) via the shared
 *    {@link describeBadge}, which also covers the monitored/unmonitored states.
 *
 * When a download is in flight the badge is clickable (emits `badgeClick` so
 * the host can open the detail modal) — except on TV, where a focusable in-card
 * button would add a second D-pad stop and break card focus traversal.
 */
@Component({
  selector: 'app-request-status-badge',
  standalone: true,
  imports: [TranslatePipe, ProgressBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Transparent to layout so the inner badge stays the flex item it replaced.
  host: { class: 'contents' },
  templateUrl: './request-status-badge.component.html',
})
export class RequestStatusBadgeComponent {
  private readonly downloadProgress = inject(DownloadProgressService);
  private readonly tv = inject(TvService);

  readonly request = input.required<FliksRequestRow>();
  /** Emitted when the (clickable) download badge is activated. */
  readonly badgeClick = output<void>();

  readonly descriptor = computed<DownloadBadgeDescriptor>(() => {
    const r = this.request();
    // Delete requests are download-free: APPROVED is their terminal "done"
    // state, so the plain status label always applies.
    if (r.kind !== 'delete' && (r.status === 'approved' || r.status === 'processing')) {
      const id = r.media?.id;
      const progress =
        id != null ? (this.downloadProgress.progress().get(id) ?? null) : null;
      return describeBadge(progress, {
        monitored: r.media?.monitored ?? false,
        downloaded: false,
        seasonFilter: r.seasons ?? undefined,
      });
    }
    return {
      labelKey: 'requests.status.' + r.status,
      badgeClass: this.statusBadgeClass(r.status),
      percent: null,
      isClickable: false,
      busy: false,
    };
  });

  /** Clickable on web/mobile only (see class doc on the TV exclusion). */
  readonly clickable = computed(
    () => this.descriptor().isClickable && !this.tv.isTv(),
  );

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
