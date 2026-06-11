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
import { RequestStatusBadgeComponent } from '../request-status-badge/request-status-badge.component';
import { FliksRequestRow } from '../../../core/services/api/requests.service';

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
    RequestStatusBadgeComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The host is the scroller flex item: fixed width, and a column flex so the
  // inner card fills the row's stretched height (all cards same height).
  // Compact on mobile, growing to full size on desktop/TV.
  host: { class: 'flex shrink-0 w-64 sm:w-72 lg:w-80' },
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
  /** Forwarded up from the status badge: open the download-detail modal. */
  readonly badgeClick = output<void>();

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

}
