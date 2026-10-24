import { Component, inject, signal, computed, effect, OnInit, OnDestroy, Injector, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { leavingLabel } from '../../shared/utils/cleanup.util';
import { keepRouteFresh } from '../../core/services/keep-route-fresh';
import { LocaleDatePipe } from '../../core/pipes/locale-date.pipe';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MediaService, Media, CalendarEntry } from '../../core/services/api/media.service';
import { StreamingApiService, ContinueWatchingItem, RecommendationItem } from '../../core/services/api/streaming-api.service';
import { OfflinePlaybackSyncService } from '../../core/services/offline-playback-sync.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { PlaylistsApiService, Playlist } from '../../core/services/api/playlists-api.service';
import { LikesApiService, LikedItem, LikeTarget } from '../../core/services/api/likes-api.service';
import { RequestsService, FliksRequestRow } from '../../core/services/api/requests.service';
import { PartyApiService, type PartySummaryDto } from '../../core/services/api/party-api.service';
import { partyWhen } from '../party/party-time';
import { pickFanart } from '../../shared/utils/media-artwork.util';
import { translatePlural } from '../../core/pipes/translate-plural.pipe';
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
import { RequestDeclineFlow } from '../requests/request-flows';
import { libraryColorVar } from '../../core/constants/library-appearance';
import { StorageScopeService } from '../../core/services/storage-scope.service';
import { itemArtwork } from '../../shared/utils/media-artwork.util';
import { armPageSlide } from '../../shared/utils/page-slide';
import { CacheRead } from '../../core/interceptors/cache.interceptor';

/** Home page: horizontal sections for libraries, continue watching, coming soon, recently added and recommendations. */
@Component({
  selector: 'app-home',
  imports: [
    RouterLink, TranslatePipe, DefaultFocusDirective,
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
  private readonly partyApi = inject(PartyApiService);
  private readonly downloadProgress = inject(DownloadProgressService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly navbar = inject(NavbarService);
  private readonly translate = inject(TranslateService);
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
      void this.loadAllSections({ known: true });
      queueMicrotask(() => void this.loadAllSections({ force: true }));
    },
    // On resume the sections are already rendered, so a cache-first pass would
    // repaint nothing.
    refreshOnResume: () => void this.loadAllSections({ force: true }),
    scrollKey: HomeComponent.SCROLL_KEY,
  });
  private readonly declineModal = viewChild(RequestDeclineModalComponent);
  readonly decline = new RequestDeclineFlow(() => this.declineModal());
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
  readonly leavingSoon = signal<Media[]>([]);
  /** Live and scheduled watch parties of the viewer, live first (server order). */
  readonly parties = signal<PartySummaryDto[]>([]);
  protected partyUrl(p: PartySummaryDto): string[] {
    return ['/parties', '' + p.id];
  }
  protected partySubtitle(p: PartySummaryDto): string {
    return p.status === 'live'
      ? translatePlural(this.translate, 'party.card_live', p.memberCount, { host: p.host.username })
      : this.translate.instant('party.card_scheduled', {
          when: p.scheduledAt ? partyWhen(p.scheduledAt, this.translate) : '',
          host: p.host.username,
        });
  }
  protected readonly leavingLabel = (m: Media) => leavingLabel(this.translate, m.deleteAt!);
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
  /** Gates the skeleton and fade-in; cleared after the cold-start reveal since `reuse: true` re-attaches this instance and would replay animations. */
  readonly coldStart = signal(!HomeComponent.skeletonShown);
  /** True until every section resolves once; the skeleton stands in for the page during that pass. */
  readonly loadingFirstPass = signal(this.coldStart());

  /** Shape of one skeleton row: how the zone's cards are laid out. */
  private static readonly SHAPES: Partial<Record<HomeSectionType, 'tile' | 'landscape' | 'portrait'>> = {
    'watch-parties': 'landscape',
    libraries: 'tile',
    'continue-watching': 'landscape',
    likes: 'landscape',
  };
  private static readonly LAYOUT_KEY = 'fliks.home.layout';
  /** Last rendered layout, replayed as the next cold-start skeleton so placeholders match the real zones. */
  readonly skeletonLayout = signal<{ shape: string; cards: number[] }[]>([]);
  /** Stays up past the swap so it fades out over the zones staggering in beneath it. */
  private readonly skeletonFadingOut = signal(false);
  readonly showSkeleton = computed(() => this.loadingFirstPass() || this.skeletonFadingOut());

  /** Form-factor exclusions belong to `HomeSettingsService.resolve`, which is
   *  what produced `sections()`: a zone hidden on TV is not in it at all. */
  readonly visibleSections = computed(() =>
    this.sections().filter((s) => s.visible),
  );

  qualityProfileDisplay(id: number | null): string {
    if (id == null) return '-';
    return this.qualityProfileNames().get(id) ?? `#${id}`;
  }
  languageProfileDisplay(id: number | null): string {
    if (id == null) return '-';
    return this.languageProfileNames().get(id) ?? `#${id}`;
  }

  protected partyImage(p: PartySummaryDto): string | null {
    return pickFanart({ ...p.item, id: p.item.mediaId }) ?? p.item.posterUrl;
  }
  protected partyState(p: PartySummaryDto): Record<string, unknown> {
    return { party: p };
  }

  private loadParties(): void {
    void this.partyApi.list().then(
      (l) => this.parties.set(l),
      () => undefined,
    );
  }

  private readonly partyEvents = this.sse.partyEvents.subscribe((e) => {
    if (this.routeFresh()) return;
    if (e.type === 'party.updated' || e.type === 'party.invited' || e.type === 'party.starting') this.loadParties();
  });

  /** A stopped playback (here or on a driven device) leaves the row stale; the server announces every stop to all connections. */
  private readonly playbackStopped = this.sse.stopped.subscribe(() => {
    // A parked page refetches everything when it comes back.
    if (this.routeFresh() || !this.visibleSections().some((s) => s.type === 'continue-watching')) return;
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
    this.loadRecentRequests({ force: true });
  });
  /** Re-filters on the "only my requests" toggle; skips the first run since ngOnInit already loads. */
  private firstOnlyMyRequestsRun = true;
  private readonly onlyMyRequestsEffect = effect(() => {
    void this.displaySettings.settings().onlyMyRequests;
    if (this.firstOnlyMyRequestsRun) {
      this.firstOnlyMyRequestsRun = false;
      return;
    }
    void this.loadFilteredSections();
  });
  /** Re-fetches recently-added on ranking-mode or zone changes; skips the first run since ngOnInit already loads. */
  private firstHomeSettingsRun = true;
  private readonly homeSettingsEffect = effect(() => {
    void this.home.settings();
    if (this.firstHomeSettingsRun) {
      this.firstHomeSettingsRun = false;
      return;
    }
    this.loadRecentRequests();
    void this.loadFilteredSections();
  });

  /** Library cards stack their page, the rail switches root; both read a tap, not a system-owned gesture (no pointerup). */
  protected readonly armSlide = armPageSlide;

  isMixedLibrary(id: number): boolean {
    return (this.libraries().find((l) => l.id === id)?.mediaTypes.length ?? 0) > 1;
  }

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
      case 'watch-parties': return this.parties().length;
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
    await this.loadAllSections({ known: true });
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
    // App-open SWR: pass 1 rendered from cache; force a network refresh that overwrites signals in place.
    queueMicrotask(() => void this.loadAllSections({ force: true }));
    this.scrollMemory.restore(HomeComponent.SCROLL_KEY, this.injector);
  }

  ngOnDestroy() {
    this.scrollMemory.deactivate();
    this.playbackStopped.unsubscribe();
  }

  /** Fetches every section in parallel, keeping existing values visible until each response lands.
   * `known` paints whatever is cached; `force` always hits the network (the SWR refresh after first paint). */
  private async loadAllSections(opts: CacheRead = {}): Promise<void> {
    try {
      // Uncached rows paint on arrival: awaiting them holds the skeleton over
      // cached rows for as long as a dead link takes to fail.
      void this.playlistsApi.list(opts).then(
        (pls) =>
          this.playlists.set(
            [...pls].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20),
          ),
        () => undefined,
      );
      void this.likesApi.mine(undefined, opts).then((likes) => this.likes.set(likes), () => undefined);
      this.loadRecentRequests(opts);
      this.loadParties();
      const [libs, cw, recs] = await Promise.all([
        this.librariesApi.listMine(opts).catch(() => null),
        this.streamingApi.getContinueWatching(undefined, opts).catch(() => null),
        this.streamingApi.getRecommendations(opts).catch(() => null),
      ]);
      if (libs) this.libraries.set(libs);
      if (cw) this.continueWatchingRaw.set(cw);
      if (recs) this.recommendations.set(recs);
    } catch { /* ignore */ }
    await this.loadFilteredSections(opts);
  }

  /** Uncached: sent before any await, so a refresh's two passes overlap and share one request. */
  private loadRecentRequests(opts: CacheRead = {}) {
    if (!this.visibleSections().some((s) => s.type === 'requests-recent')) return;
    void this.requestsService
      .list({ limit: 12 }, opts)
      .then((r) => this.recentRequests.set(r.data), () => undefined);
  }

  private async loadFilteredSections(opts: CacheRead = {}) {
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

    try {
      const [recent, calendar, libEntries] = await Promise.all([
        this.mediaService.getRecentlyAdded(
          {
            mode,
            limit: 20,
            excludeWatched: true,
            requestedByMe: mine || undefined,
          },
          opts,
        ),
        this.mediaService.getCalendar(startStr, in30dStr, true, mine, opts).catch(() => []),
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
                opts,
              )
              .then((items) => [s.libraryId as number, items] as const)
              .catch(() => [s.libraryId as number, [] as Media[]] as const),
          ),
        ),
      ]);
      this.recentMedia.set(recent);
      void this.mediaService.getLeavingSoon(opts).then((l) => this.leavingSoon.set(l), () => undefined);
      this.libraryRecent.set(new Map(libEntries));
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

  async submitDecline() {
    const id = this.decline.forId();
    if (id == null) return;
    this.requestActionBusyId.set(id);
    try {
      this.patchRequest(
        await this.requestsService.decline(id, this.decline.reasonText()),
      );
      this.decline.close();
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

  /** Removes the card optimistically; a failed request restores the list via a fresh fetch. */
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

  /** Plays the first playable file (full media fetched on demand, the lean DTO has no file ids); falls back to detail. */
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

  /** Only "mark watched": recommendations are pre-filtered to unwatched, so no inline indicator. */
  recommendationActions(rec: RecommendationItem): CardAction[] {
    return [
      {
        labelKey: 'media_card.mark_watched',
        icon: 'eye',
        run: () => void this.markRecommendationWatched(rec),
      },
    ];
  }

  /** Series marks in bulk, movies via their first file (fetched on demand); drops the title from the list. */
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

  /** Needs a movie with a file or a series (bulk endpoint); lean rows without a file keep it hidden. */
  canMarkMediaWatched(m: Media): boolean {
    return m.type === 'series' || !!m.files?.length;
  }

  async toggleContinueWatchingWatched(item: ContinueWatchingItem, watched: boolean) {
    try {
      await this.streamingApi.toggleWatched(item.mediaId, item.mediaFileId, item.episodeId ?? undefined);
      // Marking may surface the next episode (backend auto-advances), so refetch the row rather than filter locally.
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
        // Recently-added is loaded with excludeWatched=true, so drop the watched row now.
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
