import { Component, booleanAttribute, ElementRef, InjectionToken, input, output, computed, inject, linkedSignal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgClass, DecimalPipe } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideFilm, LucidePlay, LucideStar, LucideCheck, LucideClock, LucideEllipsisVertical, LucideCircleX, LucideHeart, LucideDownload } from '@lucide/angular';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { MediaType } from '../../../core/enums/media-type.enum';
import { Media } from '../../../core/services/api/media.service';
import { computeMediaBarStatus } from '../../utils/media-status.util';
import { MediaService } from '../../../core/services/api/media.service';
import { ToastService } from '../../../core/services/toast.service';
import { IdentifyModalService } from '../../../core/services/identify-modal.service';
import { TrackingModalService } from '../../../core/services/tracking-modal.service';
import { CardActionsDirective } from '../../directives/card-actions.directive';
import { SpoilerDirective } from '../../directives/spoiler.directive';
import { clearPosterStamps, previewPosterName, stampPoster, stampPosterNamed } from '../../utils/view-transition';
import { armPageSlide } from '../../utils/page-slide';
import { ServerConfigService } from '../../../core/services/server-config.service';
import { PosterMosaicComponent } from '../poster-mosaic/poster-mosaic';
import { imageUrlWithSize } from '../../../core/pipes/resolve-url.pipe';
import { CardAction, CardActionsService } from '../../../core/services/card-actions.service';
import { AddToPlaylistService } from '../../../core/services/add-to-playlist.service';
import { RecommendService } from '../../../core/services/recommend.service';
import { TvService } from '../../../core/services/tv.service';
import { AuthService } from '../../../core/services/auth.service';
import { DeviceService } from '../../../core/services/device.service';
import { PlayableMediaService } from '../../../core/services/playable-media.service';
import { NavbarService } from '../../../core/services/navbar.service';
import { PluginUiRegistryService } from '../../../core/plugin-ui/plugin-ui-registry.service';
import { evaluateWhen, type WhenContext } from '../../../core/plugin-ui/when-evaluator';
import { hasProviderId } from '../../../core/utils/media-identity';
import type { UiContribution } from '@fliks/plugin-ui';
import { CORE_MEDIA_ACTIONS, sectionOf } from '../media-info-header/core-media-actions';
import { resolveMenuContributions } from '../../../core/plugin-ui/resolve-menu-contributions';
import { resolveMediaAction, type MediaActionHandlers } from '../../../core/plugin-ui/media-action-registry';
import { CachedSrcDirective } from '../../directives/cached-src.directive';
import { isActive, type DownloadStatus } from '../../../core/services/download-status';
import { DisplaySettingsService } from '../../../core/services/display-settings.service';

/** Provided by the search page so its cards keep the type badge under the 'search' setting. */
export const SEARCH_CARD_CONTEXT = new InjectionToken<boolean>('SEARCH_CARD_CONTEXT');

export type MediaCardAspect = 'portrait' | 'landscape';

export type BarStatus =
  | 'downloaded-monitored'
  | 'downloaded-unmonitored'
  | 'missing-monitored'
  | 'missing-unmonitored'
  | 'unreleased'
  | 'queued';

export type CardBadge = 'library' | 'pending' | 'declined' | 'added' | null;
export type CardStatus = 'watched' | 'missing' | null;

/** What the device holds for the card's title: shown as a glyph when ready, a ring while in flight. */
export interface CardDownloadState {
  status: DownloadStatus;
  progress: number;
}

@Component({
  selector: 'app-media-card',
  imports: [
    CachedSrcDirective, PosterMosaicComponent,RouterLink, NgClass, DecimalPipe, ResolveUrlPipe, TranslatePipe,
    LucideFilm, LucidePlay, LucideStar, LucideCheck, LucideClock, LucideEllipsisVertical, LucideCircleX, LucideHeart, LucideDownload,
    CardActionsDirective, SpoilerDirective],
  templateUrl: './media-card.html',
  // Stable card identity for focus memory (`focusIdAttr`); the focused figure wraps the link, so `href` can't serve.
  host: { '[attr.data-card-link]': '_link()?.toString()' },
})
export class MediaCardComponent {
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly tv = inject(TvService);
  private readonly cardActionsService = inject(CardActionsService);
  private readonly addToPlaylist = inject(AddToPlaylistService);
  private readonly mediaApi = inject(MediaService);
  private readonly toast = inject(ToastService);
  private readonly identifyModal = inject(IdentifyModalService);
  private readonly trackingModal = inject(TrackingModalService);
  private readonly recommend = inject(RecommendService);
  private readonly auth = inject(AuthService);
  private readonly playableMedia = inject(PlayableMediaService);
  private readonly navbar = inject(NavbarService);
  private readonly pluginUi = inject(PluginUiRegistryService);
  protected readonly device = inject(DeviceService);
  private readonly displaySettings = inject(DisplaySettingsService);
  private readonly inSearch = inject(SEARCH_CARD_CONTEXT, { optional: true }) ?? false;
  /** Hover overlay (play button) only makes sense on a real pointer device. */
  protected readonly showHoverOverlay = computed(() => !this.selectOnly() && this.device.input() === 'mouse');
  /** The figure is the single focus target; child links stay clickable but never steal spatial-nav focus. */
  protected readonly innerTabindex = -1;

  // Data source (auto-derives imageUrl, title, rating, link, playable, status badge)
  readonly media = input<Media | null>(null);

  // Layout
  readonly aspect = input<MediaCardAspect>('portrait');
  /** Width classes for a landscape card: the width lives on an inner element, so the host can't size it. */
  readonly widthClass = input<string | null>(null);

  /** Frames the card in the primary colour — marks the card as the one
   *  the current page is already showing. */
  readonly highlighted = input(false);

  /** Desaturates the image — marks content that hasn't aired/released yet. */
  readonly grayscale = input(false);

  // Image (override media.posterUrl)
  readonly imageUrl = input<string | null>(null);
  /** 2 to 4 posters shown as a mosaic instead of `imageUrl`. */
  readonly posters = input<string[]>([]);
  /** Landscape artwork the destination hero shows for a feed-row card; the poster morph lands on it. */
  readonly fanartUrl = input<string | null>(null);
  /** Mask the image behind a blur until the viewer clicks it (anti-spoiler). */
  readonly spoiler = input(false);

  // Text (override media.title / media.rating)
  readonly title = input('');
  readonly subtitle = input<string | undefined>(undefined);
  readonly rating = input(0);
  /** Series to hand an episode link, for a card that shows episode text and so
   *  can't be given `[media]` without changing what it displays. */
  readonly seedMedia = input<Media | null>(null);

  // Badges
  readonly topLeftBadge = input<string | undefined>(undefined);
  /** Marks a card as a movie or a series, for the mixed provider results where
   *  the poster alone does not say which. */
  readonly mediaTypeBadge = input<MediaType | string | null>(null);
  readonly badge = input<CardBadge>(null);
  readonly status = input<CardStatus>(null);
  /** Bottom-left download indicator; null shows nothing (failed counts as nothing). */
  readonly downloadState = input<CardDownloadState | null>(null);
  protected readonly downloadInFlight = computed(() => {
    const d = this.downloadState();
    return d && isActive(d.status) ? d : null;
  });

  // Navigation (override media-derived link)
  readonly link = input<string[] | null>(null);
  /** Destination for the title line when it differs from the card's own: an
   *  episode card titled with its series sends the title to the series page. */
  readonly titleLink = input<string[] | null>(null);
  /** Poster of the title's destination, so its hero is there for the morph. */
  readonly titlePosterUrl = input<string | null>(null);
  /** Replace the current history entry instead of pushing, so one back exits the media (sibling seasons/episodes). */
  readonly replaceUrl = input(false);
  readonly playable = input(false);

  // Progress
  readonly progressPercent = input(0);

  /** Suppress the media-derived status badge (top-left of the poster). */
  readonly hideStatusBar = input(false);
  /** Drop the title / subtitle block, for callers that render the caption
   *  themselves beside the tile rather than under it. */
  readonly hideCaption = input(false);

  // State
  readonly dimmed = input(false);
  readonly dismissable = input(false);
  /** 'open' navigates to detail; 'play' means the parent handles (clicked) and the panel skips its Play action. */
  readonly clickIntent = input<'open' | 'play'>('open');
  /** Makes the top-right check an always-visible toggle; parents must handle {@link watchedToggled} to persist. */
  readonly interactiveWatched = input(false);
  /** Viewer's like on this card; `null` hides the heart. Parents persist via {@link likeToggled}. */
  readonly liked = input<boolean | null>(null);
  /** Caller-owned action the `card.actions` registry can't express; spliced between watched toggle and Remove. */
  readonly extraActions = input<CardAction[]>([]);
  /** Library media id for "add to playlist" when the card isn't fed by `[media]`; falls back to `media().id`. */
  readonly playlistMediaId = input<number | null>(null);
  /** Episode id for the "add to playlist" action on episode-backed cards
   *  (e.g. continue-watching an episode). Takes precedence over the media id. */
  readonly playlistEpisodeId = input<number | null>(null);

  // Events
  /** A picker's poster: no links, hover overlay or actions panel, just `clicked`. */
  readonly selectOnly = input(false, { transform: booleanAttribute });
  readonly clicked = output<void>();
  readonly played = output<void>();
  readonly dismissed = output<void>();
  /** Emits the desired target state (true = mark watched, false = unmark). */
  readonly watchedToggled = output<boolean>();
  /** Emits the desired target state (true = like, false = unlike). */
  readonly likeToggled = output<boolean>();

  // Resolved template values (explicit input wins over media-derived default)
  protected readonly _img = computed(() => this.imageUrl() ?? this.media()?.posterUrl ?? null);
  /** Both reset by every new image, so a card recycled by @for retries. */
  protected readonly imgLoaded = linkedSignal<string | null, boolean>({
    source: this._img,
    computation: () => false,
  });
  protected readonly imgFailed = linkedSignal<string | null, boolean>({
    source: this._img,
    computation: () => false,
  });
  protected readonly _title = computed(() => this.title() || this.media()?.title || '');
  protected readonly _rating = computed(() => this.rating() || this.media()?.rating || 0);
  protected readonly _link = computed(() => {
    if (this.selectOnly()) return null;
    if (this.link()) return this.link();
    const m = this.media();
    return m ? ['/' + (m.type === 'movie' ? 'movies' : 'series'), '' + m.id] : null;
  });
  /** Hands a full Media (or stub) to the detail page via router state so it renders without a spinner. */
  readonly navState = computed(() => {
    if (this.linkState()) return this.linkState();
    const preview = this.previewTarget();
    if (preview) {
      return {
        preview: {
          externalId: preview.externalId,
          title: this._title(),
          posterUrl: this._img(),
          fanartUrl: this.fanartUrl(),
        },
      };
    }
    const episodeId = this.episodeIdFromLink();
    if (episodeId != null) {
      // Series in hand: the episode page resolves from its season tree; otherwise a stub for the poster morph.
      const series = this.media() ?? this.seedMedia();
      if (series) return { media: series };
      return {
        episode: {
          id: episodeId,
          stillUrl: this._img(),
          title: this._title(),
          label: this._subtitle() ?? null,
        },
      };
    }
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
      fanartUrl: this.fanartUrl() ?? null,
    } as unknown as Media;
    return { media: stub };
  });
  /** The title's destination seeded like the card's own, so its hero renders
   *  in time to pair with the card's picture. */
  readonly titleNavState = computed(() => {
    const id = this.titleMediaId();
    if (id == null) return undefined;
    const stub = {
      id,
      type: this.titleLink()![0] === '/series' ? 'series' : 'movie',
      title: this._title(),
      posterUrl: this.titlePosterUrl(),
      fanartUrl: this.fanartUrl() ?? null,
    } as unknown as Media;
    return { media: stub };
  });

  private titleMediaId(): number | null {
    const id = Number(this.titleLink()?.at(-1));
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  /** Stamped imperatively just before navigating: a declarative name duplicated across cards aborts the transition. */
  private readonly imgRef = viewChild<ElementRef<HTMLImageElement>>('cardImg');
  private readonly overlayRef = viewChild<ElementRef<HTMLElement>>('cardOverlay');

  /** Off when the destination is the page the card sits on: a duplicate name aborts the transition. */
  readonly posterMorph = input(true);
  /** Pairing name of a destination that is not a media page; its hero must carry the same one. */
  readonly posterName = input<string | null>(null);
  /** Router state handed to [link]'s page, replacing the media seed. */
  readonly linkState = input<Record<string, unknown> | undefined>(undefined);

  /** Opens the contextual panel anchored on the figure with placement 'card-top'. */
  protected openActions(event: Event) {
    event.stopPropagation();
    event.preventDefault();
    const button = event.currentTarget as HTMLElement | null;
    if (!button) return;
    this.cardActionsService.register({
      actions: this.cardActions(),
      anchor: button.closest('figure') ?? button,
      title: this._title(),
      imageUrl: this._img(),
      imageAspect: this.aspect(),
      subtitle: this._subtitle(),
      placement: 'card-top',
    });
    this.cardActionsService.show();
  }

  /** A `/add/<movie|tv>/[provider/]<id>` link: a title the library does not hold. */
  private readonly previewTarget = computed(() => {
    const hit = this.link()?.join('/').match(/^\/add\/(movie|tv)\/(?:([^/]+)\/)?([^/]+)$/);
    return hit ? { type: hit[1], provider: hit[2] ?? 'tmdb', externalId: hit[3] } : null;
  });

  /** Episode id when [link] targets an episode page, null otherwise. */
  private episodeIdFromLink(): number | null {
    const link = this.link();
    const at = link?.indexOf('episode') ?? -1;
    if (at < 0) return null;
    const id = Number(link![at + 1]);
    return Number.isFinite(id) && id > 0 ? id : null;
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

  /** Stamps `view-transition-name: media-poster-<id>` before navigating (episode cards use the episode id).
   * The name stays until the next stamp, which wipes others: the back transition needs it, duplicates abort. */
  /** Pointerdown helper for inline `[routerLink]` anchors: prepares the transition and marks back-pop intent for `replaceUrl`. */
  /** The title opens another page (the series behind an episode): the card's
   *  picture morphs into that page's hero, dissolving into its artwork. */
  protected onTitleAnchorPointerdown() {
    const img = this.imgRef()?.nativeElement;
    const id = this.titleMediaId();
    if ('startViewTransition' in document && this.posterMorph() && img && id != null) {
      stampPoster(img, id, null, this.overlayRef()?.nativeElement);
      this.prefetch(this.fanartUrl());
    } else {
      clearPosterStamps();
    }
    this.markNavigationIntent();
  }

  /** A link outside the card opening the same page owes the same stamp and stack intent. */
  onAnchorPointerdown() {
    this.flagPosterForTransition();
    this.markNavigationIntent();
  }

  /** Whether a way out of the card stacks a page or replaces it; a replaced URL is not pushed on the back stack nor slid out of. */
  private markNavigationIntent(): void {
    if (this.replaceUrl()) this.navbar.markAsBackNavigation();
    else armPageSlide();
  }

  private readonly serverConfig = inject(ServerConfigService);

  /** Decodes the destination artwork during the click: the transition captures before its images decode and would fly the poster. */
  private prefetchHeroArtwork() {
    // An episode page shows the still this card already carries, not the
    // series fanart the media below would hand over.
    const url =
      this.episodeIdFromLink() != null
        ? this._img()
        : (this.media()?.fanartUrl ?? this.fanartUrl());
    this.prefetch(url);
  }

  private prefetch(url: string | null | undefined) {
    if (!url) return;
    const img = new Image();
    img.decoding = 'async';
    img.src = this.serverConfig.resolveUrl(imageUrlWithSize(url, 'medium'));
  }

  protected flagPosterForTransition(): void {
    // Pointless where the engine has no View Transitions (Chromium <111, Tizen 5.5
    // WebKit, webOS 5), and it costs a querySelectorAll per click.
    if (!('startViewTransition' in document)) return;
    if (!this.posterMorph()) {
      // A stamp left by an earlier click would pair with this navigation's hero
      // and morph the wrong image.
      clearPosterStamps();
      return;
    }
    const img = this.imgRef()?.nativeElement;
    const named = this.posterName();
    if (named && img) {
      stampPosterNamed(img, named, this.overlayRef()?.nativeElement);
      return;
    }
    const preview = this.previewTarget();
    if (preview && img) {
      stampPosterNamed(
        img,
        previewPosterName(preview.type, preview.provider, preview.externalId),
        this.overlayRef()?.nativeElement,
      );
      return;
    }
    const id = this.resolveMediaId();
    if (id == null || !img) return;
    stampPoster(img, id, this.episodeIdFromLink(), this.overlayRef()?.nativeElement);
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
    const m = this.media();
    return m ? computeMediaBarStatus(m) : null;
  });

  protected onCardClick() {
    if (this.selectOnly()) {
      this.clicked.emit();
      return;
    }
    this.prefetchHeroArtwork();
    this.flagPosterForTransition();
    // 'play' intent: the parent's (clicked) handler routes to /watch, so don't navigate to detail here.
    if (this.clickIntent() !== 'play') {
      const link = this._link();
      if (link) {
        // A replaced URL must not be pushed onto NavbarService's back stack.
        this.markNavigationIntent();
        void this.router.navigate(link, {
          state: this.navState(),
          replaceUrl: this.replaceUrl(),
        });
      }
    }
    this.clicked.emit();
  }

  /** Navigates to the detail link without emitting `clicked` (the "Ouvrir" action on intercepted cards). */
  protected openDetail() {
    const link = this._link();
    if (!link) return;
    this.flagPosterForTransition();
    if (this.replaceUrl()) this.navbar.markAsBackNavigation();
    void this.router.navigate(link, {
      state: this.navState(),
      replaceUrl: this.replaceUrl(),
    });
  }

  protected onWatchedClick(event: Event) {
    event.stopPropagation();
    this.watchedToggled.emit(this.status() !== 'watched');
  }

  protected onLikeClick(event: Event) {
    event.stopPropagation();
    this.likeToggled.emit(!this.liked());
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
      backdropUrl: m.fanartUrl ?? this._img() ?? null,
      streamInfo: (file as any).streamInfo,
    }, false);
  }

  // ── card.actions: the contextual panel, rendered from the contribution registry ──

  private readonly cardActionsContext = computed<WhenContext>(() => ({
    isAdmin: this.auth.hasPermission('settings.access'),
    hasPermission: (p: string) => this.auth.hasPermission(p),
    mediaType: this.media()?.type,
    hasFiles: this._playable(),
    isMonitored: this.media()?.monitored,
    hasQualityProfile: !!this.media()?.qualityProfile,
    isEpisode: this.playlistEpisodeId() != null,
    identified: !this.media() || hasProviderId(this.media()!),
    isTv: this.tv.isTv(),
    isTouch: this.device.isTouch(),
    surface: 'card',
  }));

  /** Visibility rules the closed `when` vocabulary can't express (no link/playable/dismissable predicate). */
  private readonly extraGuards: Record<string, () => boolean> = {
    'core.play': () => {
      const hasLink = !!this._link();
      return (this.clickIntent() === 'play' && hasLink) || (this.clickIntent() !== 'play' && this._playable());
    },
    'core.open': () => !!this._link(),
    'core.add_to_playlist': () => this.media()?.id != null || this.playlistMediaId() != null || this.playlistEpisodeId() != null,
    'core.recommend': () => {
      const mediaId = this.media()?.id ?? this.playlistMediaId();
      return mediaId != null && !this.auth.sharingDisabled();
    },
    'core.toggle_watched': () => this.interactiveWatched(),
    'core.like': () => this.liked() !== null,
    'core.remove': () => this.dismissable(),
    // Identity and metadata re-read need a library row; search/discovery cards have none.
    'core.identify': () => this.media()?.id != null,
    'core.refresh_metadata': () => this.media()?.id != null,
  };

  /** `media.actions` ids a card serves; modal-backed ones navigate to detail with the action armed.
   * A null id resolves to nothing and is dropped (fail-closed). */
  /** Actions a card can perform; absent ids are dropped, which keeps page-state rows (requests, releases) off a card. */
  private readonly actionHandlers = {
    'media.play': () => (this.clickIntent() === 'play' ? this.onCardClick() : this.onPlayClick(new Event('synthetic'))),
    'media.open': () => this.openDetail(),
    'media.toggle-watched': () => this.watchedToggled.emit(this.status() !== 'watched'),
    'media.toggle-like': () => this.likeToggled.emit(!this.liked()),
    'media.toggle-series-watched': () => this.watchedToggled.emit(this.status() !== 'watched'),
    'media.remove': () => this.dismissed.emit(),
    'media.open-tracking': () => {
      const mediaId = this.media()?.id ?? this.playlistMediaId();
      if (mediaId == null) return;
      this.trackingModal.open(mediaId, this.media()?.type === 'series' ? { kind: 'series' } : { kind: 'movie' });
    },
    'media.identify': () => {
      const m = this.media();
      if (!m) return;
      this.identifyModal.open({
        mediaId: m.id,
        mediaType: m.type,
        title: m.title,
        year: m.year ?? null,
        path: m.path ?? null,
        tmdbId: m.tmdbId ?? null,
        tvdbId: m.tvdbId ?? null,
        imdbId: m.imdbId ?? null,
      });
    },
    'media.refresh-metadata': () => {
      const mediaId = this.media()?.id;
      if (mediaId == null) return;
      void this.mediaApi.refreshMetadata(mediaId).then(
        () => this.toast.success(this.translate.instant('media_detail.refresh_launched')),
        () => undefined, // the interceptor surfaces the failure
      );
    },
    'media.add-to-playlist': () => {
      const episodeId = this.playlistEpisodeId();
      const mediaId = this.media()?.id ?? this.playlistMediaId();
      this.addToPlaylist.open(episodeId != null ? { episodeId } : { mediaId: mediaId! });
    },
    'media.recommend': () => {
      const mediaId = this.media()?.id ?? this.playlistMediaId();
      this.recommend.open({ mediaId: mediaId!, episodeId: this.playlistEpisodeId() ?? undefined });
    },
  } satisfies MediaActionHandlers;

  /** Core list merged with registry contributions, sorted by weight then id and filtered; unknown ids/kinds drop the row.
   * `extraActions` splices in after the watched toggle, before Remove. */
  protected readonly cardActions = computed((): CardAction[] => {
    if (this.selectOnly()) return [];
    const ctx = this.cardActionsContext();
    const watched = this.status() === 'watched';
    const rows = resolveMenuContributions({
      contributions: [...CORE_MEDIA_ACTIONS, ...this.pluginUi.contributionsFor('media.actions'),
        // `card.actions` stays read: it is in the plugin contract and installed
        // plugins target it. One list on our side, both slots on theirs.
        ...this.pluginUi.contributionsFor('card.actions'),
      ],
      ctx,
      guards: this.extraGuards,
      resolveAction: (id) => resolveMediaAction(id, this.actionHandlers),
      navigate: (path) => void this.router.navigate([path]),
    });

    const resolved = rows.map((r) => {
      const isToggle = r.actionId === 'media.toggle-watched';
      const isLike = r.actionId === 'media.toggle-like';
      return {
        weight: r.weight,
        action: {
          labelKey: isToggle ? (watched ? 'media_card.mark_unwatched' : 'media_card.mark_watched')
            : isLike ? (this.liked() ? 'likes.unlike' : 'likes.like') : r.labelKey,
          icon: isToggle ? (watched ? 'eye-off' : 'eye') : r.icon,
          tone: r.tone,
          section: sectionOf(r.weight),
          ...(r.route ? { route: r.route } : {}),
          ...(r.children?.length
            ? { children: r.children.map((c) => ({
                labelKey: c.labelKey, icon: c.icon, tone: c.tone, run: c.run!,
              })) }
            : {}),
          run: r.run!,
        } as CardAction,
      };
    });

    const extra = this.extraActions();
    const actions = resolved.map((r) => r.action);
    if (extra.length) {
      const insertAt = resolved.findIndex((r) => r.weight >= 900);
      if (insertAt === -1) actions.push(...extra);
      else actions.splice(insertAt, 0, ...extra);
    }
    return actions;
  });

  /** Falls back to an auto-detected 'missing' marker when the library item has no playable files yet. */
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
  /** Blue for a movie, pink for a series: `info` and `secondary` are the theme's
   *  blue and pink hues. */
  protected readonly typeBadge = computed((): { text: string; class: string } | null => {
    if (!this.inSearch && this.displaySettings.settings().mediaTypeBadge === 'search') return null;
    switch (this.mediaTypeBadge()) {
      case 'movie':
        return { text: this.translate.instant('media_card.type_movie'), class: 'badge-info' };
      case 'series':
        return {
          text: this.translate.instant('media_card.type_series'),
          class: 'badge-secondary',
        };
      default:
        return null;
    }
  });

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
