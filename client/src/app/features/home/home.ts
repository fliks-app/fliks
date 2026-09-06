import { Component, ChangeDetectionStrategy, inject, signal, computed, effect, OnInit, OnDestroy, Injector, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { keepRouteFresh } from '../../core/services/keep-route-fresh';
import { LocaleDatePipe } from '../../core/pipes/locale-date.pipe';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MediaService, Media, CalendarEntry } from '../../core/services/api/media.service';
import { StreamingApiService, ContinueWatchingItem, RecommendationItem } from '../../core/services/api/streaming-api.service';
import { OfflinePlaybackSyncService } from '../../core/services/offline-playback-sync.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { PlaylistsApiService, Playlist } from '../../core/services/api/playlists-api.service';
import { LikesApiService, LikedItem, LikeTarget } from '../../core/services/api/likes-api.service';
import { RequestsService, FliksRequestRow } from '../../core/services/api/requests.service';
import { SseService } from '../../core/services/sse.service';
import {
  DownloadProgressService,
  MediaDownloadProgress,
} from '../../core/services/download-progress.service';
import { DownloadDetailModalComponent } from '../../shared/components/download-detail-modal/download-detail-modal';
import { ProfilesService } from '../../core/services/api/profiles.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { PlayableMediaService } from '../../core/services/playable-media.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { DefaultFocusDirective } from '../../shared/directives/default-focus.directive';
import { NavbarService } from '../../core/services/navbar.service';
import { BackgroundService } from '../../core/services/background.service';
import { DisplaySettingsService } from '../../core/services/display-settings.service';
import { HomeSettingsService, HomeSectionType, ResolvedHomeSection } from '../../core/services/home-settings.service';
import { LibraryPrefsService } from '../../core/services/library-prefs.service';
import { CardAction } from '../../core/services/card-actions.service';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { MosaicCardComponent } from '../../shared/components/mosaic-card/mosaic-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { LucideIconComponent } from '../../shared/components/lucide-icon';
import { SetupChecklistComponent } from '../../shared/components/setup-checklist/setup-checklist';
import { FollowRequestsCardComponent } from '../../shared/components/follow-requests-card/follow-requests-card';
import { ReceivedRecommendationsCardComponent } from '../../shared/components/received-recommendations-card/received-recommendations-card';
import { TvSectionDirective } from '../../shared/directives/tv-section.directive';
import { AuthService } from '../../core/services/auth.service';
import { RequestCardComponent } from '../requests/request-card/request-card';
import { RequestDeclineModalComponent } from '../requests/request-decline-modal/request-decline-modal.component';
import { libraryColorVar } from '../../core/constants/library-appearance';
import { StorageScopeService } from '../../core/services/storage-scope.service';
import { itemArtwork } from '../../shared/utils/media-artwork.util';

/**
 * # Home page
 *
 * Displays several horizontal scroller sections:
 *
 * ## Libraries
 * One card per accessible library with custom icon + color gradient.
 * Data: `GET /api/libraries/mine`.
 *
 * ## Continuer à regarder
 * Media the user started but didn't finish (< 90% or < dur-30s).
 * Data: `GET /api/playback/continue-watching`.
 *
 * ## Bientôt disponible
 * Movies (digitalRelease) and episodes (airDate) releasing within
 * -3 days to +30 days that are monitored and don't have a file yet.
 * Keeps entries visible up to 3 days after release date so newly
 * released content stays until actually downloaded.
 * Data: `GET /api/media/calendar?start=<J-3>&end=<J+30>&monitoredOnly=true`.
 * Client-side filter: `!hasFile && (event === 'digital' || 'airing' || 'release')`.
 * Deduplicated by mediaId (earliest date kept).
 *
 * ## Récemment ajoutés
 * Last 20 media (movies + series mixed), excluding already-watched entries,
 * ranked by the user's `recentlyAddedMode` (media add time / newest file /
 * both). Opt-in per-library variants render the same feed scoped to one
 * library. Data: `GET /api/media/recently-added`.
 *
 * ## Recommandations
 * Genre-based suggestions derived from the user's watch history.
 * See `RecommendationService` for the algorithm.
 * Data: `GET /api/playback/recommendations`.
 */
@Component({
  selector: 'app-home',
  imports: [
    RouterLink, TranslateModule, DefaultFocusDirective,
    LocaleDatePipe,
    MediaCardComponent,
    MosaicCardComponent,
    HorizontalScrollerComponent,
    LucideIconComponent,
    SetupChecklistComponent,
    FollowRequestsCardComponent,
    ReceivedRecommendationsCardComponent,
    TvSectionDirective,
    RequestCardComponent,
    RequestDeclineModalComponent,
    DownloadDetailModalComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.html',
})
export class HomeComponent implements OnInit, OnDestroy {
  private readonly mediaService = inject(MediaService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly offlineSync = inject(OfflinePlaybackSyncService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly router = inject(Router);
  private readonly playableMedia = inject(PlayableMediaService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly storageScope = inject(StorageScopeService);
  private readonly playlistsApi = inject(PlaylistsApiService);
  private readonly likesApi = inject(LikesApiService);
  private readonly requestsService = inject(RequestsService);
  private readonly sse = inject(SseService);
  private readonly downloadProgress = inject(DownloadProgressService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly navbar = inject(NavbarService);
  private readonly translate = inject(TranslateService);
  private readonly backgroundService = inject(BackgroundService);
  private readonly displaySettings = inject(DisplaySettingsService);
  private readonly home = inject(HomeSettingsService);
  private readonly libraryPrefs = inject(LibraryPrefsService);
  readonly auth = inject(AuthService);
  private readonly injector = inject(Injector);
  private readonly route = inject(ActivatedRoute);
  protected readonly itemArtwork = itemArtwork;

  private static readonly SCROLL_KEY = 'home';
  /** Cached route: the stale signals stay on screen while a cache-first pass
   *  repaints and a forced pass brings in what changed elsewhere. */
  private readonly routeFresh = keepRouteFresh({
    refresh: () => {
      void this.loadAllSections();
      queueMicrotask(() => void this.loadAllSections({ force: true }));
    },
    // On resume the sections are already rendered, so a cache-first pass would
    // repaint nothing.
    refreshOnResume: () => void this.loadAllSections({ force: true }),
    scrollKey: HomeComponent.SCROLL_KEY,
  });
  private readonly declineModal = viewChild(RequestDeclineModalComponent);
  private readonly detailModal = viewChild(DownloadDetailModalComponent);

  /** Media whose download-detail modal is open; its live progress is fed in. */
  readonly detailMediaId = signal<number | null>(null);
  readonly detailProgress = computed<MediaDownloadProgress | null>(() => {
    const id = this.detailMediaId();
    return id != null ? (this.downloadProgress.progress().get(id) ?? null) : null;
  });

  readonly libraries = signal<LibrarySummary[]>([]);
  private readonly continueWatchingRaw = signal<ContinueWatchingItem[]>([]);
  /** Server list with any position queued while offline layered on top — the
   *  API keeps returning the pre-offline progress until the queue flushes. */
  readonly continueWatching = computed(() =>
    this.offlineSync.overlayProgress(this.continueWatchingRaw()),
  );
  readonly recentMedia = signal<Media[]>([]);
  readonly comingSoon = signal<CalendarEntry[]>([]);
  readonly recommendations = signal<RecommendationItem[]>([]);
  /** Accessible playlists ordered by last modification, for the "playlists" zone. */
  readonly playlists = signal<Playlist[]>([]);
  /** The viewer's liked content, for the "likes" zone. */
  readonly likes = signal<LikedItem[]>([]);
  /** Recently-added items per library, keyed by library id (opt-in zones). */
  readonly libraryRecent = signal<Map<number, Media[]>>(new Map());
  /** Latest requests (scoped to rights by the backend) for the optional
   *  "Demandes récentes" zone. */
  readonly recentRequests = signal<FliksRequestRow[]>([]);
  readonly requestActionBusyId = signal<number | null>(null);
  readonly declineForId = signal<number | null>(null);
  readonly declineReasonText = signal('');
  private qualityProfileNames = signal<Map<number, string>>(new Map());
  private languageProfileNames = signal<Map<number, string>>(new Map());

  /** Whether the user may have requests at all (own via create, or all via
   *  manage) — gates the "Demandes récentes" zone in home + settings. */
  get requestsAllowed(): boolean {
    return (
      this.auth.hasPermission('requests.create') ||
      this.auth.hasPermission('requests.manage')
    );
  }
  /** Managers can approve/decline and see the requester. */
  get canManageRequests(): boolean {
    return this.auth.hasPermission('requests.manage');
  }

  /** Accessible libraries in the user's chosen order, with hidden ones
   *  removed — the set surfaced on the home page (cards + per-library zones). */
  readonly displayLibraries = computed(() =>
    this.libraryPrefs.present(this.libraries()),
  );

  /** The user's resolved home layout (order + visibility), reconciled with
   *  the libraries they can currently access. Drives template rendering. */
  readonly sections = computed(() =>
    this.home.resolve(
      this.displayLibraries().map((l) => ({ id: l.id, name: l.name })),
      { requests: this.requestsAllowed },
    ),
  );
  /** Cold-start affordance only: coming back to Home serves cached data, so a
   *  placeholder would flash for nothing. */
  private static skeletonShown = false;
  /** Gates the skeleton and the staggered fade-in. Cleared once the cold-start
   *  reveal has played: the route is `reuse: true`, so a back-navigation
   *  re-attaches this same instance and re-inserting the subtree would replay
   *  every CSS animation still declared on it. */
  readonly coldStart = signal(!HomeComponent.skeletonShown);
  /** True until the first pass over every section resolves. Each section only
   *  renders once its own data lands, so a cold start would otherwise show an
   *  empty page; the skeleton stands in for the whole page during that pass. */
  readonly loadingFirstPass = signal(this.coldStart());

  /** Shape of one skeleton row: how the zone's cards are laid out. */
  private static readonly SHAPES: Partial<Record<HomeSectionType, 'tile' | 'landscape' | 'portrait'>> = {
    libraries: 'tile',
    'continue-watching': 'landscape',
    likes: 'landscape',
  };
  private static readonly LAYOUT_KEY = 'fliks.home.layout';
  /** Last rendered layout, replayed as the skeleton on the next cold start so
   *  the placeholders sit where the real zones will land — same order, same
   *  card shape, same count — instead of three generic rows the content then
   *  shoves around. */
  readonly skeletonLayout = signal<{ shape: string; cards: number[] }[]>([]);
  /** Kept up past the swap so it can fade out over the zones staggering in
   *  beneath it — removing it on the swap leaves each row blank until its own
   *  delay elapses. */
  private readonly skeletonFadingOut = signal(false);
  readonly showSkeleton = computed(() => this.loadingFirstPass() || this.skeletonFadingOut());

  /** Form-factor exclusions belong to `HomeSettingsService.resolve`, which is
   *  what produced `sections()`: a zone hidden on TV is not in it at all. */
  readonly visibleSections = computed(() =>
    this.sections().filter((s) => s.visible),
  );

  qualityProfileDisplay(id: number | null): string {
    if (id == null) return '—';
    return this.qualityProfileNames().get(id) ?? `#${id}`;
  }
  languageProfileDisplay(id: number | null): string {
    if (id == null) return '—';
    return this.languageProfileNames().get(id) ?? `#${id}`;
  }

  /** Once the recommendations land, randomise the page background
   *  using their fanarts (primary + extras). One pick per visit;
   *  the BackgroundService keeps it stable while the user stays on
   *  the home — same contract as media-detail. */
  private readonly recommendationsBackgroundEffect = effect(() => {
    const recs = this.recommendations();
    if (recs.length === 0) return;
    if (!this.displaySettings.settings().homeBackground) {
      this.backgroundService.clear();
      return;
    }
    const pool: string[] = [];
    for (const r of recs) {
      if (r.media.fanartUrl) pool.push(r.media.fanartUrl);
      pool.push(...(r.media.additionalFanartUrls ?? []));
    }
    if (pool.length) this.backgroundService.setBackgrounds(pool);
  });

  /** A playback that ended leaves this row stale, whether it ran here or on a
   *  device this one is driving. The server announces every session stop to all
   *  of the account's connections, so one subscription covers both. */
  private readonly playbackStopped = this.sse.stopped.subscribe(() => {
    if (!this.visibleSections().some((s) => s.type === 'continue-watching')) return;
    this.streamingApi
      .getContinueWatching(undefined, { force: true })
      .then((list) => this.continueWatchingRaw.set(list))
      .catch(() => {
        // The row keeps its previous contents rather than emptying on a blip.
      });
  });

  /** When a download finishes, refresh the recent-requests row so a monitored
   *  request flips to its downloaded badge without a manual reload. */
  private readonly importEffect = effect(() => {
    const ev = this.sse.lastEvent();
    if (ev?.type !== 'import.complete') return;
    const wantRequests = this.visibleSections().some(
      (s) => s.type === 'requests-recent',
    );
    if (!wantRequests) return;
    this.requestsService
      .list({ limit: 12 }, { force: true })
      .then((r) => this.recentRequests.set(r.data))
      .catch(() => {});
  });
  /** Reactively re-filter the home rows whenever the user flips the
   *  "only my requests" toggle in display settings. Skips the very first
   *  invocation so we don't double-fetch on initial page load — ngOnInit
   *  already calls loadAllSections(). */
  private firstOnlyMyRequestsRun = true;
  private readonly onlyMyRequestsEffect = effect(() => {
    void this.displaySettings.settings().onlyMyRequests;
    if (this.firstOnlyMyRequestsRun) {
      this.firstOnlyMyRequestsRun = false;
      return;
    }
    void this.loadFilteredSections();
  });
  /** Re-fetch the recently-added rows when the user changes the ranking mode
   *  or enables/reorders zones from the home settings page. Skips the initial
   *  run — ngOnInit already loads the sections. */
  private firstHomeSettingsRun = true;
  private readonly homeSettingsEffect = effect(() => {
    void this.home.settings();
    if (this.firstHomeSettingsRun) {
      this.firstHomeSettingsRun = false;
      return;
    }
    void this.loadFilteredSections();
  });

  libraryUrl(lib: LibrarySummary): string {
    return `/libraries/${encodeURIComponent(lib.name)}`;
  }

  libraryColor(lib: LibrarySummary): string {
    return libraryColorVar(lib.color);
  }

  openPlaylist(id: number): void {
    void this.router.navigate(['/playlists', id]);
  }

  isLiked(mediaId: number, episodeId?: number | null, seasonId?: number | null): boolean {
    return this.likes().some(
      (l) => l.mediaId === mediaId && l.episodeId === (episodeId ?? null) && l.seasonId === (seasonId ?? null),
    );
  }

  /** Refetches the row: a new like needs the title/artwork only the server has. */
  async toggleLike(target: LikeTarget, liked: boolean) {
    try {
      await (liked ? this.likesApi.like(target) : this.likesApi.unlike(target));
      const likes = await this.likesApi.mine(undefined, { force: true });
      this.likes.set(likes);
    } catch { /* interceptor surfaces errors */ }
  }

  /** Route to a liked item: the episode page when it targets an episode,
   *  otherwise the movie or series detail page. */
  likeLink(item: LikedItem): string[] {
    if (item.episodeId) {
      return ['/series', String(item.mediaId), 'episode', String(item.episodeId)];
    }
    return ['/' + (item.mediaType === 'series' ? 'series' : 'movies'), String(item.mediaId)];
  }

  /** Cards actually rendered by each zone, for the layout snapshot. */
  private sectionCount(s: ResolvedHomeSection): number {
    switch (s.type) {
      case 'libraries': return this.displayLibraries().length;
      case 'continue-watching': return this.continueWatching().length;
      case 'recommendations': return this.recommendations().length;
      case 'likes': return this.likes().length;
      case 'recently-added': return this.recentMedia().length;
      case 'playlists': return this.playlists().length;
      case 'coming-soon': return this.comingSoon().length;
      case 'requests-recent': return this.recentRequests().length;
      case 'library-recent': return this.libraryRecent().get(s.libraryId ?? -1)?.length ?? 0;
      default: return 0; // received-recommendations is a card, not a rail
    }
  }

  private captureLayout(): void {
    const rows = this.visibleSections()
      .map((s) => ({
        shape: HomeComponent.SHAPES[s.type] ?? 'portrait',
        cards: Math.min(this.sectionCount(s), 8),
      }))
      .filter((r) => r.cards > 0);
    if (!rows.length) return;
    try {
      localStorage.setItem(
        `${HomeComponent.LAYOUT_KEY}::${this.storageScope.suffix()}`,
        JSON.stringify(rows),
      );
    } catch { /* quota or private mode — the generic skeleton still works */ }
  }

  private readLayout(): { shape: string; cards: number[] }[] {
    let rows: { shape: string; cards: number }[] = [];
    try {
      rows = JSON.parse(
        localStorage.getItem(`${HomeComponent.LAYOUT_KEY}::${this.storageScope.suffix()}`) ?? '[]',
      );
    } catch { /* corrupt — fall through to the default below */ }
    if (!Array.isArray(rows) || !rows.length) {
      rows = [{ shape: 'portrait', cards: 7 }, { shape: 'portrait', cards: 7 }, { shape: 'portrait', cards: 7 }];
    }
    return rows.map((r) => ({
      shape: r.shape ?? 'portrait',
      cards: Array.from({ length: Math.max(1, Math.min(r.cards ?? 7, 8)) }, (_, i) => i),
    }));
  }

  async ngOnInit() {
    this.scrollMemory.activate(HomeComponent.SCROLL_KEY);
    // Profile names for the request cards are resolved client-side (same as
    // the requests page); load them once for users who can have requests.
    if (this.requestsAllowed) void this.loadRequestProfiles();
    // Each section guards itself with `@if (().length)` so sections paint
    // independently as their data arrives. No global loading gate.
    const cold = this.coldStart();
    HomeComponent.skeletonShown = true;
    if (cold) this.skeletonLayout.set(this.readLayout());
    await this.loadAllSections();
    if (cold) {
      this.skeletonFadingOut.set(true);
      this.loadingFirstPass.set(false);
      // Long enough for the last zone's staggered fade to have finished.
      setTimeout(() => {
        this.skeletonFadingOut.set(false);
        this.coldStart.set(false);
      }, 1200);
    }
    this.captureLayout();
    // App-open SWR: the cache served Pass 1 above (instant render even on
    // a cold network). Now force a network round-trip so the user sees
    // the freshest data — additions, watched-status flips made on
    // another device, new recommendations, etc. — without waiting on it.
    // Signals already populated, so a slower fresh response just
    // overwrites in place; no spinner, no flash.
    queueMicrotask(() => void this.loadAllSections({ force: true }));
    this.scrollMemory.restore(HomeComponent.SCROLL_KEY, this.injector);
  }

  ngOnDestroy() {
    this.scrollMemory.deactivate();
    this.playbackStopped.unsubscribe();
    this.backgroundService.clear();
  }

  /**
   * Fetch every section in parallel. Signals are updated as responses land —
   * existing values stay visible until each new response arrives, so a
   * background revalidation never blanks the UI.
   *
   * The pattern is two-pass SWR-on-demand:
   *   • Pass 1 (default): cache-first. The interceptor serves IndexedDB
   *     if fresh, network otherwise. Renders the home in ≤1 frame on a
   *     warm cache.
   *   • Pass 2 (`{ force: true }`): always go to network. Fired right
   *     after Pass 1 from `ngOnInit` to refresh the home's data even
   *     when the cache was fresh — the user expects the page to reflect
   *     current backend state every time they open the app, but doesn't
   *     want to wait for the network for the first paint.
   */
  private async loadAllSections(opts: { force?: boolean } = {}): Promise<void> {
    const force = !!opts.force;
    try {
      const [libs, cw, recs, pls, likes] = await Promise.all([
        this.librariesApi.listMine({ force }).catch(() => null),
        this.streamingApi.getContinueWatching(undefined, { force }).catch(() => null),
        this.streamingApi.getRecommendations({ force }).catch(() => null),
        this.playlistsApi.list({ force }).catch(() => null),
        this.likesApi.mine(undefined, { force }).catch(() => null),
      ]);
      if (libs) this.libraries.set(libs);
      if (cw) this.continueWatchingRaw.set(cw);
      if (recs) this.recommendations.set(recs);
      if (pls)
        this.playlists.set(
          [...pls]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, 20),
        );
      if (likes) this.likes.set(likes);
    } catch { /* ignore */ }
    await this.loadFilteredSections({ force });
  }

  private async loadFilteredSections(opts: { force?: boolean } = {}) {
    const force = !!opts.force;
    const mine = this.displaySettings.settings().onlyMyRequests;
    const mode = this.home.settings().recentlyAddedMode;
    const today = new Date();
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const in30d = new Date(today);
    in30d.setDate(in30d.getDate() + 30);
    const startStr = threeDaysAgo.toISOString().slice(0, 10);
    const in30dStr = in30d.toISOString().slice(0, 10);

    // Only fetch per-library rows the user has actually enabled (opt-in).
    const libSections = this.visibleSections().filter(
      (s) => s.type === 'library-recent' && s.libraryId != null,
    );
    const wantRequests = this.visibleSections().some(
      (s) => s.type === 'requests-recent',
    );

    try {
      const [recent, calendar, libEntries, requests] = await Promise.all([
        this.mediaService.getRecentlyAdded(
          {
            mode,
            limit: 20,
            excludeWatched: true,
            requestedByMe: mine || undefined,
          },
          { force },
        ),
        this.mediaService.getCalendar(startStr, in30dStr, true, mine, { force }).catch(() => []),
        Promise.all(
          libSections.map((s) =>
            this.mediaService
              .getRecentlyAdded(
                {
                  libraryId: s.libraryId,
                  mode,
                  limit: 20,
                  excludeWatched: true,
                  requestedByMe: mine || undefined,
                },
                { force },
              )
              .then((items) => [s.libraryId as number, items] as const)
              .catch(() => [s.libraryId as number, [] as Media[]] as const),
          ),
        ),
        wantRequests
          ? this.requestsService
              .list({ limit: 12 }, { force })
              .then((r) => r.data)
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      this.recentMedia.set(recent);
      this.libraryRecent.set(new Map(libEntries));
      if (requests) this.recentRequests.set(requests);
      const upcoming = calendar
        .filter((e) => !e.hasFile && (e.event === 'digital' || e.event === 'airing' || e.event === 'release'))
        .sort((a, b) => a.date.localeCompare(b.date));
      const seen = new Set<number>();
      this.comingSoon.set(
        upcoming.filter((e) => {
          if (seen.has(e.mediaId)) return false;
          seen.add(e.mediaId);
          return true;
        }),
      );
    } catch { /* ignore */ }
  }

  private async loadRequestProfiles() {
    try {
      const [qp, lp] = await Promise.all([
        this.profilesApi.getQualityProfiles(),
        this.profilesApi.getLanguageProfiles(),
      ]);
      this.qualityProfileNames.set(new Map(qp.map((p) => [p.id, p.name])));
      this.languageProfileNames.set(new Map(lp.map((p) => [p.id, p.name])));
    } catch {
      /* profiles optional — cards fall back to "#id" */
    }
  }

  async approveRequest(id: number) {
    this.requestActionBusyId.set(id);
    try {
      this.patchRequest(await this.requestsService.approve(id));
    } catch {
      /* global error toast */
    } finally {
      this.requestActionBusyId.set(null);
    }
  }

  /** Open the download-detail modal for a request card's media (badge click). */
  onBadgeClick(row: FliksRequestRow): void {
    const id = row.media?.id;
    if (id == null) return;
    this.detailMediaId.set(id);
    this.detailModal()?.open();
  }

  openDecline(id: number) {
    this.declineForId.set(id);
    this.declineReasonText.set('');
    this.declineModal()?.showModal();
  }

  closeDecline() {
    this.declineModal()?.close();
    this.declineForId.set(null);
  }

  async submitDecline() {
    const id = this.declineForId();
    if (id == null) return;
    this.requestActionBusyId.set(id);
    try {
      this.patchRequest(
        await this.requestsService.decline(id, this.declineReasonText()),
      );
      this.closeDecline();
    } catch {
      /* global error toast */
    } finally {
      this.requestActionBusyId.set(null);
    }
  }

  private patchRequest(updated: FliksRequestRow) {
    this.recentRequests.update((list) =>
      list.map((r) => (r.id === updated.id ? updated : r)),
    );
  }

  /**
   * Persist a "remove from recommendations" gesture. The local list is
   * updated optimistically so the card disappears immediately; a failed
   * request restores it via a fresh fetch.
   */
  async dismissRecommendation(rec: RecommendationItem) {
    const id = rec.media.id;
    this.recommendations.update((list) => list.filter((r) => r.media.id !== id));
    try {
      await this.streamingApi.dismissRecommendation(id);
    } catch {
      // Restore the row by refetching — the global error toast already fired.
      this.streamingApi
        .getRecommendations()
        .then((list) => this.recommendations.set(list))
        .catch(() => {});
    }
  }

  /**
   * Recommendation cards expose a Lire action even though the lean DTO
   * doesn't carry file ids — we fetch the full media on demand and route
   * to the first playable file. If nothing is playable (e.g. a "to add"
   * suggestion not yet downloaded) we fall back to the detail page.
   */
  async playRecommendation(rec: RecommendationItem) {
    try {
      const media = await this.mediaService.getOne(rec.media.id);
      const file = media.files?.[0];
      if (!file) {
        const segment = media.type === 'series' ? 'series' : 'movies';
        void this.router.navigate(['/' + segment, media.id]);
        return;
      }
      await this.playableMedia.play({
        fileId: file.id,
        mediaId: media.id,
        episodeId: file.episodeId ?? undefined,
        title: media.title,
        fanartUrl: media.fanartUrl ?? media.posterUrl ?? null,
        streamInfo: (file as any).streamInfo,
      }, false);
    } catch {
      /* error handled by global interceptor */
    }
  }

  /** Context-menu action(s) for a recommendation card: just "mark watched".
   *  Recommendations are pre-filtered to unwatched media, so no inline watched
   *  indicator is needed — only the menu action that marks it and drops it. */
  recommendationActions(rec: RecommendationItem): CardAction[] {
    return [
      {
        labelKey: 'media_card.mark_watched',
        icon: 'eye',
        run: () => void this.markRecommendationWatched(rec),
      },
    ];
  }

  /** Mark a recommended title watched (series → bulk; movie → its first file,
   *  fetched on demand since the lean DTO carries no file id) and drop it from
   *  the list, which is filtered to unwatched titles. */
  private async markRecommendationWatched(rec: RecommendationItem) {
    const id = rec.media.id;
    try {
      if (rec.media.type === 'series') {
        await this.streamingApi.toggleSeriesWatched(id, true);
      } else {
        const media = await this.mediaService.getOne(id);
        const fileId = media.files?.[0]?.id;
        if (!fileId) return;
        await this.streamingApi.toggleWatched(id, fileId);
      }
      this.recommendations.update((list) => list.filter((r) => r.media.id !== id));
    } catch {
      /* global error toast */
    }
  }

  async playContinueWatching(item: ContinueWatchingItem) {
    await this.playableMedia.resume(item);
  }

  /** "Mark as watched" can only fire on a movie with at least one file
   *  or a series (bulk-toggle endpoint). For lean rows that don't expose
   *  a file (e.g. recommendations without a local copy) the action stays
   *  hidden from the context menu. */
  canMarkMediaWatched(m: Media): boolean {
    return m.type === 'series' || !!m.files?.length;
  }

  async toggleContinueWatchingWatched(item: ContinueWatchingItem, watched: boolean) {
    try {
      await this.streamingApi.toggleWatched(item.mediaId, item.mediaFileId, item.episodeId ?? undefined);
      // Mark-watched drops the current episode but may surface the next
      // one in the series (the backend auto-advances continue-watching).
      // Refetch the row instead of filtering locally so the user sees the
      // next episode appear in place rather than the card vanishing.
      if (watched) {
        const list = await this.streamingApi.getContinueWatching(undefined, { force: true }).catch(() => null);
        if (list) this.continueWatchingRaw.set(list);
      }
    } catch { /* global error toast */ }
  }

  async toggleRecentMediaWatched(m: Media, watched: boolean) {
    try {
      if (m.type === 'series') {
        await this.streamingApi.toggleSeriesWatched(m.id, watched);
      } else {
        const fileId = m.files?.[0]?.id;
        if (!fileId) return;
        await this.streamingApi.toggleWatched(m.id, fileId);
      }
      if (watched) {
        // Recently-added is loaded with excludeWatched=true, so a watched
        // row would vanish on the next refresh anyway — remove it now to
        // match the visible expectation.
        this.recentMedia.update(list => list.filter(x => x.id !== m.id));
      }
    } catch { /* global error toast */ }
  }

  /** Same as {@link toggleRecentMediaWatched} for a per-library recently-added
   *  row — drops the watched item from that library's bucket. */
  async toggleLibraryRecentWatched(libraryId: number, m: Media, watched: boolean) {
    try {
      if (m.type === 'series') {
        await this.streamingApi.toggleSeriesWatched(m.id, watched);
      } else {
        const fileId = m.files?.[0]?.id;
        if (!fileId) return;
        await this.streamingApi.toggleWatched(m.id, fileId);
      }
      if (watched) {
        this.libraryRecent.update((map) => {
          const items = map.get(libraryId);
          if (!items) return map;
          const next = new Map(map);
          next.set(libraryId, items.filter((x) => x.id !== m.id));
          return next;
        });
      }
    } catch { /* global error toast */ }
  }

  async removeContinueWatching(item: ContinueWatchingItem) {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('home.cw_remove_title'),
      message: this.translate.instant('home.cw_remove_message', { title: item.mediaTitle }),
    });
    if (!confirmed) return;
    try {
      await this.streamingApi.hideFromContinueWatching(item.mediaId);
      this.continueWatchingRaw.update(list => list.filter(i => i.mediaId !== item.mediaId));
    } catch { /* ignore */ }
  }
}
