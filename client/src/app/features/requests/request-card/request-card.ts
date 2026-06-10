import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { RequestPosterComponent } from '../request-poster';
import { ProgressBadgeComponent } from '../../../shared/components/progress-badge/progress-badge.component';
import { DownloadProgressService } from '../../../core/services/download-progress.service';
import {
  FliksRequestRow,
  FliksRequestStatus,
} from '../../../core/services/api/requests.service';

/**
 * Compact request card for the home "Demandes récentes" scroller: a fanart
 * backdrop with the request summary overlaid and (for managers, on pending
 * requests) Approuver / Refuser actions. The parent owns data + actions and
 * resolves the profile names; this card is presentational.
 */
@Component({
  selector: 'app-request-card',
  imports: [
    DatePipe,
    RouterLink,
    TranslateModule,
    RequestPosterComponent,
    ProgressBadgeComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The host is the scroller flex item: fixed width, and a column flex so the
  // inner card fills the row's stretched height (all cards same height).
  // Compact on mobile, growing to full size on desktop/TV.
  host: { class: 'flex shrink-0 w-64 sm:w-72 lg:w-80' },
  templateUrl: './request-card.html',
})
export class RequestCardComponent {
  private readonly downloadProgress = inject(DownloadProgressService);

  readonly request = input.required<FliksRequestRow>();
  readonly canManage = input(false);
  readonly qualityProfileName = input('—');
  readonly languageProfileName = input('—');
  readonly busy = input(false);

  readonly approve = output<number>();
  readonly decline = output<number>();

  /** Backdrop art: the request's own stored fanart, falling back to the
   *  linked media's (both local `/api/images` paths). Null lets the poster
   *  component fall back to the metadata lookup (pre-existing requests). */
  readonly fanartArt = computed(
    () => this.request().fanartUrl ?? this.request().media?.fanartUrl ?? null,
  );

  /** Route to the linked media, or to the add page when not yet imported.
   *  Mirrors `RequestsComponent.mediaLink`. */
  readonly mediaLink = computed<(string | number)[]>(() => {
    const r = this.request();
    const id = r.media?.id;
    if (id) {
      return r.mediaType === 'movie' ? ['/movies', id] : ['/series', id];
    }
    return r.mediaType === 'movie'
      ? ['/add', 'movie', r.tmdbId]
      : ['/add', 'tv', r.tmdbId];
  });

  statusBadgeClass(status: FliksRequestStatus): string {
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

  /** Status badge key — approved/processing tracks the media's monitored state;
   *  available reads as "downloaded". Mirrors the requests page. */
  badgeLabelKey(): string {
    const r = this.request();
    if (r.status === 'approved' || r.status === 'processing') {
      return r.media?.monitored
        ? 'requests.badge_monitored'
        : 'requests.badge_unmonitored';
    }
    return 'requests.status.' + r.status;
  }

  badgeClassFor(): string {
    const r = this.request();
    if (r.status === 'approved' || r.status === 'processing') {
      return r.media?.monitored ? 'badge-info' : 'badge-ghost';
    }
    return this.statusBadgeClass(r.status);
  }

  progressPercent(): number | null {
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
  }
}
