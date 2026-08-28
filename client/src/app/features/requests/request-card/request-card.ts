import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LucideTrash2 } from '@lucide/angular';
import { RequestPosterComponent } from '../request-poster';
import { RequestStatusBadgeComponent } from '../request-status-badge/request-status-badge.component';
import { FliksRequestRow } from '../../../core/services/api/requests.service';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';
import { clearPosterStamps } from '../../../shared/utils/view-transition';

/**
 * Compact request card for the home "Demandes récentes" scroller: a fanart
 * backdrop with the request summary overlaid and (for managers, on pending
 * requests) Approuver / Refuser actions. The parent owns data + actions and
 * resolves the profile names; this card is presentational.
 */
@Component({
  selector: 'app-request-card',
  imports: [
    LocaleDatePipe,
    RouterLink,
    TranslateModule,
    RequestPosterComponent,
    RequestStatusBadgeComponent,
    LucideTrash2,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The host is the scroller flex item: fixed width, and a column flex so the
  // inner card fills the row's stretched height (all cards same height).
  // Compact on mobile, growing to full size on desktop/TV.
  // The host is the single focusable unit (like a media card): it carries
  // tabindex/role and the focus ring (via its data-home-focus attribute on the
  // home page), while inner links/buttons sit at tabindex=-1 so keyboard and
  // D-pad navigation move card-to-card instead of into the card. Activating the
  // card opens the linked media.
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
  readonly qualityProfileName = input('—');
  readonly languageProfileName = input('—');
  readonly busy = input(false);

  readonly approve = output<number>();
  readonly decline = output<number>();
  /** Forwarded up from the status badge: open the download-detail modal. */
  readonly badgeClick = output<void>();

  protected readonly ariaLabel = computed(
    () => this.request().media?.title ?? this.request().title,
  );

  /** Activate the whole card (Enter / Space / click) → open the linked media,
   *  mirroring a media card. Inner controls stop propagation so they still fire
   *  their own action without also navigating. */
  protected onCardActivate(event?: Event): void {
    event?.preventDefault();
    // This card has no poster to morph from, so drop whatever card was stamped
    // last — otherwise the media page animates in from an unrelated card that
    // happens to show the same title.
    clearPosterStamps();
    void this.router.navigate(this.mediaLink());
  }

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
