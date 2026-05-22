import { Component, ChangeDetectionStrategy, ElementRef, input, output, computed, inject, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgClass, DecimalPipe } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideFilm, LucidePlay, LucideStar, LucideCheck, LucideClock, LucideEllipsisVertical, LucideCircleX } from '@lucide/angular';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { Media } from '../../../core/services/api/media.service';
import { Capacitor } from '@capacitor/core';
import { computeMediaBarStatus, computeMediaBarPercent } from '../../utils/media-status.util';
import { CardActionsDirective } from '../../directives/card-actions.directive';
import { CardAction, CardActionsService } from '../../../core/services/card-actions.service';
import { TvService } from '../../../core/services/tv.service';
import { DeviceService } from '../../../core/services/device.service';
import { PlayableMediaService } from '../../../core/services/playable-media.service';
import { NavbarService } from '../../../core/services/navbar.service';

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
    LucideFilm, LucidePlay, LucideStar, LucideCheck, LucideClock, LucideEllipsisVertical, LucideCircleX,
    CardActionsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-card.html',
})
export class MediaCardComponent {
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly tv = inject(TvService);
  private readonly cardActionsService = inject(CardActionsService);
  private readonly playableMedia = inject(PlayableMediaService);
  private readonly navbar = inject(NavbarService);
  protected readonly device = inject(DeviceService);
  protected readonly isNative = Capacitor.isNativePlatform();
  /** Hover overlay (play button) only makes sense on a real pointer device. */
  protected readonly showHoverOverlay = computed(() => this.device.input() === 'mouse');
  /**
   * The figure is the single focus target across every form factor —
   * child links (title, subtitle, hover overlay) stay clickable but
   * never steal the spatial nav focus from the card itself. Same
   * semantics for D-pad on TV, arrow keys on desktop, and Tab order.
   */
  protected readonly innerTabindex = -1;

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
  /** When true, navigation triggered by the card replaces the
   *  current history entry instead of pushing a new one. Useful for
   *  "cards within the same media context" (sibling seasons, sibling
   *  episodes…) so a single browser-back exits the media instead of
   *  walking up the in-page chain. */
  readonly replaceUrl = input(false);
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
   * What clicking the card actually does. Default 'open' (navigate to detail
   * via the configured link). 'play' is for sections like "Continue Watching"
   * where the parent intercepts (clicked) to launch the player directly. The
   * contextual panel uses this to show the right verb ('Lire' vs 'Ouvrir')
   * and skip the duplicate explicit Play action.
   */
  readonly clickIntent = input<'open' | 'play'>('open');
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
   * Hand the full Media (or a stub) to the detail page via router state so it
   * can render immediately instead of mounting on a blocking spinner.
   *
   * Cards built with `[imageUrl]` + `[link]` (recommendations, coming-soon,
   * continue-watching, …) don't have a full Media. Without a state handoff
   * the detail page sat on its spinner until the API responded — and during
   * the spinner phase the destination poster <img> wasn't rendered yet, so
   * the view-transition had nothing to pair with: no morph.
   *
   * We build a partial stub from `[link]` + `[imageUrl]` + `[title]` good
   * enough for the header to render. The detail page's background fetch
   * replaces it with the full Media a moment later.
   */
  protected readonly _navState = computed(() => {
    const m = this.media();
    if (m) return { media: m };
    const id = this.resolveMediaId();
    const link = this.link();
    if (id == null || !link) return undefined;
    const type: 'movie' | 'series' = link[0] === '/series' ? 'series' : 'movie';
    const stub = {
      id,
      type,
      title: this._title(),
      posterUrl: this.imageUrl() ?? null,
    } as unknown as Media;
    return { media: stub };
  });
  /**
   * `<img>` ref so we can stamp the view-transition-name imperatively just
   * before navigating. We DON'T set it declaratively — when the same media
   * appears in two cards on the same page (continue-watching + recently-added,
   * etc.) the duplicate name aborts the whole transition. Stamping at click
   * time means only the clicked card carries the name during the snapshot.
   */
  private readonly imgRef = viewChild<ElementRef<HTMLImageElement>>('cardImg');

  /**
   * Desktop affordance — opens the same contextual panel that TV's menu key
   * and mobile's long-press use. The button itself is the anchor with
   * placement 'button' so the dropdown drops right under the ⋯ glyph and
   * overlays the card body, instead of stacking below the whole figure.
   */
  protected openActions(event: Event) {
    event.stopPropagation();
    event.preventDefault();
    const button = event.currentTarget as HTMLElement | null;
    if (!button) return;
    this.cardActionsService.register({
      actions: this.cardActions(),
      anchor: button,
      title: this._title(),
      placement: 'button',
    });
    this.cardActionsService.show();
  }

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
   * Stamp `view-transition-name: media-poster-<id>` on this card's <img>
   * just before navigating. The browser snapshots the document on the
   * next tick and pairs it with the matching name on the destination's
   * poster. Wired to every click path that leads to the detail page.
   *
   * The name STAYS on the img until the next stamp clears it — both the
   * forward (card → detail) and the back (detail → card) transitions
   * need the name present at snapshot time. Auto-clearing it via a timer
   * killed the back animation. Instead, before stamping we wipe any
   * other stamped img: protects against the duplicate-name abort when the
   * same media appears in two cards (continue-watching + recently-added,
   * etc.).
   */
  /** Pointerdown helper for the inline `[routerLink]` anchors: prepare
   *  the view transition AND mark the next navigation as a back-pop
   *  when `replaceUrl` is on, so NavbarService doesn't push the
   *  replaced URL onto its history stack. Pointerdown fires before
   *  click → before RouterLink kicks off `navigateByUrl`. */
  protected onAnchorPointerdown() {
    this.flagPosterForTransition();
    if (this.replaceUrl()) this.navbar.markAsBackNavigation();
  }

  protected flagPosterForTransition() {
    // Skip on engines without View Transitions API (Chromium <111,
    // Tizen 5.5 WebKit, webOS 5 Chromium 79). Angular's
    // `withViewTransitions()` already feature-detects, but the
    // imperative DOM stamping below would mutate styles for nothing on
    // those targets and adds a querySelectorAll per click.
    if (!('startViewTransition' in document)) return;
    const id = this.resolveMediaId();
    const img = this.imgRef()?.nativeElement;
    if (id == null || !img) return;
    document
      .querySelectorAll<HTMLImageElement>('img[style*="view-transition-name"]')
      .forEach((el) => {
        if (el !== img) el.style.viewTransitionName = '';
      });
    img.style.viewTransitionName = `media-poster-${id}`;
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
    // When the parent owns the click ('play' intent), don't navigate to the
    // detail link here — the parent's (clicked) handler routes to /watch
    // directly. Otherwise we'd land on /detail for one frame before the
    // parent's navigate kicked in.
    if (this.clickIntent() !== 'play') {
      const link = this._link();
      if (link) {
        // Keep NavbarService's history stack in sync with the browser
        // history: when we replace the URL, the page we're leaving
        // must NOT be pushed onto the back stack — otherwise the
        // in-app "Retour" walks the chain of replaced entries.
        if (this.replaceUrl()) this.navbar.markAsBackNavigation();
        void this.router.navigate(link, {
          state: this._navState(),
          replaceUrl: this.replaceUrl(),
        });
      }
    }
    this.clicked.emit();
  }

  /**
   * Navigate to the detail link WITHOUT emitting `clicked`. Used by the
   * explicit "Ouvrir" menu action on cards whose normal click is intercepted
   * by the parent (Continue Watching plays directly via (clicked)).
   */
  protected openDetail() {
    const link = this._link();
    if (!link) return;
    this.flagPosterForTransition();
    if (this.replaceUrl()) this.navbar.markAsBackNavigation();
    void this.router.navigate(link, {
      state: this._navState(),
      replaceUrl: this.replaceUrl(),
    });
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
    if (!m?.files?.length) return;
    const file = m.files[0];
    void this.playableMedia.play({
      fileId: file.id,
      mediaId: m.id,
      episodeId: file.episodeId ?? undefined,
      title: m.title,
      fanartUrl: (m as any).fanartUrl ?? this._img() ?? null,
      streamInfo: (file as any).streamInfo,
    }, false);
  }

  /**
   * Actions exposed via the contextual panel (TV menu button / mobile long-press).
   * The set is derived from the same flags that drive the inline buttons so a
   * card always advertises only what it can actually do.
   */
  protected readonly cardActions = computed((): CardAction[] => {
    const actions: CardAction[] = [];
    const isPlayIntent = this.clickIntent() === 'play';
    const hasLink = !!this._link();

    // Order is uniform across every row: Play first when available, then
    // Open detail. Continue Watching's tap-plays behaviour collapses Play
    // onto onCardClick; other rows route Play through onPlayClick.
    if (isPlayIntent && hasLink) {
      actions.push({
        labelKey: 'media_card.action_play',
        icon: 'play',
        run: () => this.onCardClick(),
      });
    } else if (!isPlayIntent && this._playable()) {
      actions.push({
        labelKey: 'media_card.action_play',
        icon: 'play',
        run: () => this.onPlayClick(new Event('synthetic')),
      });
    }

    if (hasLink) {
      actions.push({
        labelKey: 'media_card.action_open',
        icon: 'external-link',
        run: () => this.openDetail(),
      });
    }
    if (this.interactiveWatched()) {
      const watched = this.status() === 'watched';
      actions.push({
        labelKey: watched ? 'media_card.mark_unwatched' : 'media_card.mark_watched',
        icon: watched ? 'eye-off' : 'eye',
        run: () => this.watchedToggled.emit(!watched),
      });
    }
    if (this.dismissable()) {
      actions.push({
        labelKey: 'media_card.remove_from_list',
        icon: 'trash-2',
        tone: 'danger',
        run: () => this.dismissed.emit(),
      });
    }
    return actions;
  });

  /**
   * Resolved top-right status. Falls back to an auto-detected `'missing'`
   * marker when the media is in the library but has no playable files yet
   * (movies: no files; series: zero downloaded episodes), so cards in
   * Recently Added / Library make the missing-file state immediately visible
   * without each parent having to wire `[status]` itself.
   */
  protected readonly _resolvedStatus = computed((): CardStatus => {
    if (this.status()) return this.status();
    if (this.badge()) return null;
    const m = this.media();
    if (!m) return null;
    const s = computeMediaBarStatus(m);
    if (s === 'missing-monitored' || s === 'missing-unmonitored') return 'missing';
    return null;
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
