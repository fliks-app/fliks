import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { RequestPosterComponent } from '../request-poster';
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
  imports: [DatePipe, RouterLink, TranslateModule, RequestPosterComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The host is the scroller flex item: fixed width, and a column flex so the
  // inner card fills the row's stretched height (all cards same height).
  host: { class: 'flex shrink-0 w-72 sm:w-80' },
  templateUrl: './request-card.html',
})
export class RequestCardComponent {
  readonly request = input.required<FliksRequestRow>();
  readonly canManage = input(false);
  readonly qualityProfileName = input('—');
  readonly languageProfileName = input('—');
  readonly busy = input(false);

  readonly approve = output<number>();
  readonly decline = output<number>();

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
}
