import { Component, ChangeDetectionStrategy, ElementRef, input, output, computed, inject, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgClass, DecimalPipe } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideFilm, LucidePlay, LucideStar, LucideCheck, LucideClock, LucideX, LucideCircleCheck, LucideCircleX } from '@lucide/angular';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { Media } from '../../../core/services/api/media.service';
import { Capacitor } from '@capacitor/core';
import { computeMediaBarStatus, computeMediaBarPercent } from '../../utils/media-status.util';
import { CardActionsDirective } from '../../directives/card-actions.directive';
import { CardAction } from '../../../core/services/card-actions.service';
import { TvService } from '../../../core/services/tv.service';
import { DeviceService } from '../../../core/services/device.service';

export type MediaCardAspect = 'portrait' | 'landscape';

export type BarStatus =
  | 'downloaded-monitored'
  | 'downloaded-unmonitored'
  | 'missing-monitored'
  | 'missing-unmonitored'
  | 'unreleased'
  | 'queued';

export type CardBadge = 'library' | 'pending' | 'declined' | null;
export type CardStatus = 'watched' | 'missing' | null;

@Component({
  selector: 'app-media-card',
  imports: [RouterLink, NgClass, DecimalPipe, ResolveUrlPipe, TranslateModule,
    LucideFilm, LucidePlay, LucideStar, LucideCheck, LucideClock, LucideX, LucideCircleCheck, LucideCircleX,
    CardActionsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-card.html',
})
export class MediaCardComponent {
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly tv = inject(TvService);
  protected readonly device = inject(DeviceService);
  protected readonly isNative = Capacitor.isNativePlatform();
  /** Hover overlay (play button) only makes sense on a real pointer device. */
  protected readonly showHoverOverlay = computed(() => this.device.input() === 'mouse');
  /**
   * On TV the figure is the single focus target — child links (title, subtitle,
   * hover overlay) are visually still navigable via the contextual actions
   * panel but should not steal focus from D-pad navigation, so we mark them
   * with tabindex=-1.
   */
  protected readonly innerTabindex = computed(() => this.tv.isTv() ? -1 : null);

  // Data source (auto-derives imageUrl, title, rating, link, playable, barStatus, barPercent)
  readonly media = input<Media | null>(null);

  // Layout
  readonly aspect = input<MediaCardAspect>('portrait');

  // Image (override media.posterUrl)
  readonly imageUrl = input<string | null>(null);
  readonly imageBlurred = input(false);

  // Text (override media.title / media.rating)
  readonly title = input('');
  readonly subtitle = input<string | undefined>(undefined);
  readonly rating = input(0);

  // Badges
  readonly topLeftBadge = input<string | undefined>(undefined);
  readonly badge = input<CardBadge>(null);
  readonly status = input<CardStatus>(null);

  // Navigation (override media-derived link)
  readonly link = input<string[] | null>(null);
  readonly subtitleLink = input<string[] | null>(null);
  readonly playable = input(false);

  // Progress
  readonly progressPercent = input(0);

  // Status bar (override media-derived barStatus/barPercent)
  readonly barStatus = input<BarStatus | null>(null);
  readonly barPercent = input(100);
  /** Hide the colored status bar entirely. */
  readonly hideStatusBar = input(false);

  // State
  readonly dimmed = input(false);
  readonly dismissable = input(false);
  /**
   * When true, the top-right check becomes a toggle button that's always
   * visible (filled green when `status()` is `'watched'`, outlined
   * otherwise). Parents must handle {@link watchedToggled} to persist the
   * change, otherwise the click does nothing.
   */
  readonly interactiveWatched = input(false);

  // Events
  readonly clicked = output<void>();
  readonly played = output<void>();
  readonly dismissed = output<void>();
  /** Emits the desired target state (true = mark watched, false = unmark). */
  readonly watchedToggled = output<boolean>();

  // Resolved template values (explicit input wins over media-derived default)
  protected readonly _img = computed(() => this.imageUrl() ?? this.media()?.posterUrl ?? null);
  protected readonly _title = computed(() => this.title() || this.media()?.title || '');
  protected readonly _rating = computed(() => this.rating() || this.media()?.rating || 0);
  protected readonly _link = computed(() => {
    if (this.link()) return this.link();
    const m = this.media();
    return m ? ['/' + (m.type === 'movie' ? 'movies' : 'series'), '' + m.id] : null;
  });
  /**
   * Hand the full Media to the detail page via router state so it can render
   * immediately with the same poster/title/year the card already shows,
   * instead of mounting on a blocking spinner. The detail page also re-fetches
   * in background to refresh fields the card doesn't carry.
   */
  protected readonly _navState = computed(() => {
    const m = this.media();
    return m ? { media: m } : undefined;
  });
  /**
   * `<img>` ref so we can stamp the view-transition-name imperatively just
   * before navigating. We DON'T set it declaratively — when the same media
   * appears in two cards on the same page (continue-watching + recently-added,
   * etc.) the duplicate name aborts the whole transition. Stamping at click
   * time means only the clicked card carries the name during the snapshot.
   */
  private readonly imgRef = viewChild<ElementRef<HTMLImageElement>>('cardImg');

  /** Resolved id from [media] or the tail of [link]. */
  private resolveMediaId(): number | null {
    const m = this.media();
    if (m) return m.id;
    const link = this.link();
    if (link && link.length >= 2) {
      const last = link[link.length - 1];
      const id = typeof last === 'number' ? last : Number(last);
      if (Number.isFinite(id) && id > 0) return id;
    }
    return null;
  }

  /**
   * Stamp `view-transition-name: media-poster-<id>` on this card's <img> just
   * before navigating. The browser snapshots the document on the next tick
   * and pairs it with the matching name on the destination's poster.
   * Wired to every click path that leads to the detail page.
   */
  protected flagPosterForTransition() {
    const id = this.resolveMediaId();
    const img = this.imgRef()?.nativeElement;
    if (id != null && img) {
      img.style.viewTransitionName = `media-poster-${id}`;
    }
  }
  protected readonly _playable = computed(() => {
    if (this.playable()) return true;
    const m = this.media();
    return m ? !!(m.files?.length) : false;
  });
  protected readonly _subtitle = computed(() => {
    if (this.subtitle() !== undefined) return this.subtitle();
    const m = this.media();
    if (m?.year) return '' + m.year;
    return undefined;
  });
  protected readonly _barStatus = computed((): BarStatus | null => {
    if (this.hideStatusBar()) return null;
    if (this.barStatus()) return this.barStatus();
    const m = this.media();
    return m ? computeMediaBarStatus(m) : null;
  });
  protected readonly _barPercent = computed(() => {
    if (!this.barStatus() && this.media()) return computeMediaBarPercent(this.media()!);
    return this.barPercent();
  });

  protected onCardClick() {
    this.flagPosterForTransition();
    const link = this._link();
    if (link) void this.router.navigate(link, { state: this._navState() });
    this.clicked.emit();
  }

  protected onWatchedClick(event: Event) {
    event.stopPropagation();
    this.watchedToggled.emit(this.status() !== 'watched');
  }

  protected onPlayClick(event: Event) {
    event.stopPropagation();
    this.played.emit();
    this.clicked.emit();
    const m = this.media();
    if (m?.files?.length) {
      const file = m.files[0];
      const qp: Record<string, number> = { mediaId: m.id };
      if (file.episodeId) qp['episodeId'] = file.episodeId;
      void this.router.navigate(['/watch', file.id], { queryParams: qp });
    }
  }

  /**
   * Actions exposed via the contextual panel (TV menu button / mobile long-press).
   * The set is derived from the same flags that drive the inline buttons so a
   * card always advertises only what it can actually do.
   */
  protected readonly cardActions = computed((): CardAction[] => {
    const actions: CardAction[] = [];
    if (this._link()) {
      actions.push({
        labelKey: 'media_card.action_open',
        run: () => this.onCardClick(),
      });
    }
    if (this._playable()) {
      actions.push({
        labelKey: 'media_card.action_play',
        run: () => this.onPlayClick(new Event('synthetic')),
      });
    }
    if (this.interactiveWatched()) {
      const watched = this.status() === 'watched';
      actions.push({
        labelKey: watched ? 'media_card.mark_unwatched' : 'media_card.mark_watched',
        run: () => this.watchedToggled.emit(!watched),
      });
    }
    if (this.dismissable()) {
      actions.push({
        labelKey: 'media_card.action_remove',
        tone: 'danger',
        run: () => this.dismissed.emit(),
      });
    }
    return actions;
  });

  /** Status badge shown in the top-left corner of the poster. */
  protected readonly statusBadge = computed((): { text: string; class: string } | null => {
    const s = this._barStatus();
    if (!s) return null;
    switch (s) {
      case 'missing-monitored':
        return { text: this.translate.instant('media_card.monitored'), class: 'badge-warning' };
      case 'missing-unmonitored':
        return { text: this.translate.instant('media_card.unmonitored'), class: 'badge-error' };
      case 'unreleased':
        return { text: this.translate.instant('media_card.unreleased'), class: 'badge-info' };
      case 'queued':
        return { text: this.translate.instant('media_card.queued'), class: 'badge-secondary' };
      default:
        return null;
    }
  });
}
