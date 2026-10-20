import {
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

/** Status badge for a request row, shared by the requests list and home card: request lifecycle states (`requests.status.*`),
 *  or the real download status via {@link describeBadge} while in flight. Clickable then (`badgeClick`), except on TV: a focusable in-card button adds a second D-pad stop. */
@Component({
  selector: 'app-request-status-badge',
  standalone: true,
  imports: [TranslatePipe, ProgressBadgeComponent],
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
