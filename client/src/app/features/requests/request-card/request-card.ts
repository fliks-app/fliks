import {
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideTrash2 } from '@lucide/angular';
import { RequestPosterComponent } from '../request-poster';
import { RequestStatusBadgeComponent } from '../request-status-badge/request-status-badge.component';
import { FliksRequestRow } from '../../../core/services/api/requests.service';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';
import { clearPosterStamps } from '../../../shared/utils/view-transition';

/** Compact presentational request card for the home scroller: fanart backdrop, summary, and Approuver / Refuser for managers on pending requests.
 *  The parent owns data and actions. */
@Component({
  selector: 'app-request-card',
  imports: [
    LocaleDatePipe,
    RouterLink,
    TranslatePipe,
    RequestPosterComponent,
    RequestStatusBadgeComponent,
    LucideTrash2,
  ],
  // The host is the scroller's flex item and the single focusable unit (tabindex/role/focus ring); inner controls sit at tabindex=-1
  // so D-pad moves card to card. Column flex makes the inner card fill the row height.
  host: {
    class: 'flex shrink-0 w-64 sm:w-72 lg:w-80 cursor-pointer rounded-box',
    tabindex: '0',
    role: 'button',
    '[attr.aria-label]': 'ariaLabel()',
    '(click)': 'onCardActivate($event)',
    '(keydown.enter)': 'onCardActivate($event)',
    '(keydown.space)': 'onCardActivate($event)',
  },
  templateUrl: './request-card.html',
})
export class RequestCardComponent {
  private readonly router = inject(Router);

  readonly request = input.required<FliksRequestRow>();
  readonly canManage = input(false);
  readonly qualityProfileName = input('-');
  readonly languageProfileName = input('-');
  readonly busy = input(false);

  readonly approve = output<number>();
  readonly decline = output<number>();
  /** Forwarded up from the status badge: open the download-detail modal. */
  readonly badgeClick = output<void>();

  protected readonly ariaLabel = computed(
    () => this.request().media?.title ?? this.request().title,
  );

  /** Activates the whole card (Enter / Space / click) to open the media; inner controls stop propagation. */
  protected onCardActivate(event?: Event): void {
    event?.preventDefault();
    // No poster to morph from: drop the last stamped card so the media page doesn't animate from an unrelated one.
    clearPosterStamps();
    void this.router.navigate(this.mediaLink());
  }

  /** Backdrop art: the request's stored fanart, else the linked media's (local `/api/images` paths); null falls back to the metadata lookup. */
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
