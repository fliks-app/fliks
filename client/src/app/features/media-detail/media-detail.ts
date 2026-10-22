import { Component, ElementRef, OnDestroy, OnInit, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { IdentifyModalService } from '../../core/services/identify-modal.service';
import { hasProviderId } from '../../core/utils/media-identity';
import { TrackingModalService } from '../../core/services/tracking-modal.service';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  MediaService,
  Media,
  Season,
  Episode,
  MediaCastEntry,
  MediaCrewEntry,
  RelatedMedia,
  MediaCollection,
} from '../../core/services/api/media.service';
import { MediaDetailReleasePickerService } from './media-detail-release-picker.service';
import { ReleaseSearchStreamService } from './release-search-stream.service';
import { AuthService } from '../../core/services/auth.service';
import { SpoilerService } from '../../core/services/spoiler.service';
import { ProfilesService, LanguageProfile } from '../../core/services/api/profiles.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { NavbarService } from '../../core/services/navbar.service';
import { BackgroundService } from '../../core/services/background.service';
import { leavingLabel, scopedLeavingLabels } from '../../shared/utils/cleanup.util';
import { pickFanart } from '../../shared/utils/media-artwork.util';
import { centerRailOnCard } from '../../shared/utils/center-rail';
import { armPageSlide } from '../../shared/utils/page-slide';
import {
  StreamingApiService,
  MediaResumeInfo,
} from '../../core/services/api/streaming-api.service';
import { MarkersApiService } from '../../core/services/api/markers-api.service';
import { RequestsService } from '../../core/services/api/requests.service';
import {
  MediaInfoHeaderComponent,
  MediaInfoHeaderBadge,
} from '../../shared/components/media-info-header/media-info-header';
import { MediaInfoExtraComponent } from '../../shared/components/media-info-extra/media-info-extra';
import { SubtitlesModalComponent } from '../../shared/components/subtitles-modal/subtitles-modal';
import { MediaFileInfoComponent } from '../../shared/components/media-file-info';
import { DefaultFocusDirective } from '../../shared/directives/default-focus.directive';
import { MediaDetailSeasonsComponent } from './components/media-detail-seasons/media-detail-seasons.component';
import { ReleasesModalComponent } from './components/releases-modal/releases-modal.component';
import { TrackingScope } from '../../shared/components/tracking-status-modal/tracking-status-modal';
import { MediaDetailProfilesModalComponent } from './components/media-detail-profiles-modal/media-detail-profiles-modal.component';
import { MediaDetailLibraryModalComponent } from './components/media-detail-library-modal/media-detail-library-modal.component';
import { RequestModalComponent } from '../tmdb-preview/components/request-modal/request-modal.component';
import { AddToPlaylistService } from '../../core/services/add-to-playlist.service';
import { RecommendService } from '../../core/services/recommend.service';
import { LikesApiService } from '../../core/services/api/likes-api.service';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { CollapsibleSectionComponent } from '../../shared/components/collapsible-section/collapsible-section';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { DownloadQualityModalComponent } from '../../shared/components/download-quality-modal/download-quality-modal';
import { DownloadManagerService, episodeLabel, type DownloadTarget } from '../../core/services/download-manager.service';
import { nothingStartedKey } from '../../core/services/download-status';
import { DownloadDetailModalComponent } from '../../shared/components/download-detail-modal/download-detail-modal';
import { collectScopedLeaves, describeDownload } from '../../shared/utils/download-format';
import { TvService } from '../../core/services/tv.service';
import { DownloadProgressService } from '../../core/services/download-progress.service';
import { filesForEpisode, filterSeasonEpisodesOnDisk, seasonsVisibleWithDiskFilter } from './media-detail.utils';
import { serverMessage } from '../../core/utils/server-message';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';
import { SseService, type SseEvent } from '../../core/services/sse.service';
import { MediaType } from '../../core/enums/media-type.enum';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { SeasonLabelPipe } from '../../core/pipes/season-label.pipe';
import { TvSectionDirective } from '../../shared/directives/tv-section.directive';
import { ImgFadeInDirective } from '../../shared/directives/img-fade-in.directive';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { keepRouteFresh } from '../../core/services/keep-route-fresh';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { ModalFooterComponent } from '../../shared/components/modal-footer';

import { ReleaseGrabController } from './release-grab-controller';
import { LikeController } from './like-controller';
import { AnalyzeController } from './analyze-controller';
import { RequestFlowController } from './request-flow-controller';
import { WatchedController } from './watched-controller';
import { EpisodeViewController } from './episode-view-controller';

const LS_EPISODES_HAS_FILE_ONLY = 'fliks.mediaDetail.episodesHasFileOnly';

function readEpisodesHasFileOnlyFromStorage(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(LS_EPISODES_HAS_FILE_ONLY) === '1';
  } catch {
    return false;
  }
}

/** What a card can hand an episode page before its media request lands. */
interface HandedEpisode {
  episodeId: number;
  stillUrl: string;
  title: string | null;
  label: string | null;
}

@Component({
  selector: 'app-media-detail',
  imports: [
    ModalFooterComponent,
    ModalHeaderComponent,
    CachedSrcDirective,
    TranslatePipe,
    DefaultFocusDirective,
    MediaInfoHeaderComponent,
    MediaInfoExtraComponent,
    SubtitlesModalComponent,
    MediaFileInfoComponent,
    MediaDetailSeasonsComponent,
    ReleasesModalComponent,
    MediaDetailProfilesModalComponent,
    MediaDetailLibraryModalComponent,
    RequestModalComponent,
    HorizontalScrollerComponent,
    CollapsibleSectionComponent,
    MediaCardComponent,
    DownloadQualityModalComponent,
    DownloadDetailModalComponent,
    RouterLink,
    NgTemplateOutlet,
    ResolveUrlPipe,
    SeasonLabelPipe,
    ImgFadeInDirective,
    TvSectionDirective,
  ],
  templateUrl: './media-detail.html',
})
export class MediaDetailComponent implements OnInit, OnDestroy {
  private readonly identifyModalService = inject(IdentifyModalService);
  private readonly trackingModalService = inject(TrackingModalService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly mediaService = inject(MediaService);
  private readonly releasePickerApi = inject(MediaDetailReleasePickerService);
  private readonly releaseStream = inject(ReleaseSearchStreamService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly auth = inject(AuthService);
  private readonly spoilers = inject(SpoilerService);
  private readonly translate = inject(TranslateService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly navbarService = inject(NavbarService);
  private readonly backgroundService = inject(BackgroundService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly sse = inject(SseService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly markersApi = inject(MarkersApiService);
  private readonly requestsApi = inject(RequestsService);
  private readonly downloadManager = inject(DownloadManagerService);
  private readonly downloadProgress = inject(DownloadProgressService);
  private readonly tv = inject(TvService);

  readonly grabs = new ReleaseGrabController(
    {
      media: () => this.media(),
      focusedSeason: () => this.focusedSeason(),
      focusedEpisode: () => this.focusedEpisode(),
      movieModal: () => this.movieReleasesModal(),
      episodeModal: () => this.episodeReleasesModal(),
      seasonModal: () => this.seasonReleasesModal(),
    },
    {
      stream: this.releaseStream,
      api: this.releasePickerApi,
      progress: this.downloadProgress,
      translate: this.translate,
    },
  );
  readonly like = new LikeController(
    {
      media: () => this.media(),
      episodeMode: () => this.episodeMode(),
      focusedEpisode: () => this.focusedEpisode(),
    },
    inject(LikesApiService),
  );
  readonly analyze = new AnalyzeController(
    {
      media: () => this.media(),
      dialog: () => this.analyzeDialog()?.nativeElement,
      firstOption: () => this.firstAnalyzeOption()?.nativeElement,
    },
    { media: this.mediaService, markers: this.markersApi, toast: this.toast, translate: this.translate },
  );
  readonly requestFlow = new RequestFlowController(
    { media: () => this.media(), requestModal: () => this.requestModal() },
    {
      auth: this.auth,
      requests: this.requestsApi,
      confirmation: this.confirmation,
      toast: this.toast,
      translate: this.translate,
    },
  );
  readonly watched = new WatchedController({ media: () => this.media() }, this.streamingApi);
  readonly episodeView = new EpisodeViewController(
    {
      media: () => this.media(),
      focusedEpisode: () => this.focusedEpisode(),
      focusedSeason: () => this.focusedSeason(),
      selectedFileId: () => this.selectedFileId(),
      resumeInfo: () => this.resumeInfo(),
    },
    { spoilers: this.spoilers, translate: this.translate, watchedEpisodeIds: this.watched.episodeIds },
  );

  /** Live download progress for the media on screen (null when not
   *  downloading). Fed by `download.progress` SSE + a one-shot seed on load. */
  readonly activeDownload = computed(() => {
    const m = this.media();
    return m ? (this.downloadProgress.progress().get(m.id) ?? null) : null;
  });

  /** Header download chip: one download shows its own state, several show a count.
   *  Downloads only; the monitored state has its own chip and menu entry. */
  private downloadBadge(
    scope: { seasonFilter?: number[]; episodeFilter?: number } = {},
  ): MediaInfoHeaderBadge | null {
    const progress = this.activeDownload();
    if (!progress) return null;
    // Non-interactive on TV: a focusable header button would add a second D-pad
    // stop. The download detail is a web/mobile drill-down.
    const clickable = !this.tv.isTv();

    const leaves = progress.seasons
      ? collectScopedLeaves(progress, scope.seasonFilter, scope.episodeFilter)
      : [];
    if (leaves.length > 1) {
      return {
        // Only ever reached with several, so the label needs no singular form.
        labelKey: 'media_detail.downloads_in_progress',
        labelParams: { count: leaves.length },
        percent: null,
        badgeClass: 'badge-info',
        clickable,
        busy: leaves.some((l) => l.leaf.state === 'searching'),
      };
    }

    const d = describeDownload(progress, scope);
    if (!d?.labelKey) return null;
    return {
      labelKey: d.labelKey,
      labelParams: null,
      percent: d.percent,
      badgeClass: d.badgeClass,
      clickable,
      busy: d.busy,
    };
  }

  /** Whole-media download progress, on the movie/series header. */
  protected scopedLeaving(seasons: Season[]): string[] {
    return scopedLeavingLabels(this.translate, seasons);
  }

  protected leavingLabel(deleteAt: string): string {
    return leavingLabel(this.translate, deleteAt);
  }

  readonly headerBadge = computed<MediaInfoHeaderBadge | null>(() =>
    this.media() ? this.downloadBadge() : null,
  );

  /** Same chip on the episode page, narrowed to that episode's own downloads or
   *  the season pack that carries it — a sibling episode's grab stays off it. */
  readonly episodeHeaderBadge = computed<MediaInfoHeaderBadge | null>(() => {
    const ep = this.focusedEpisode();
    const season = this.focusedSeason();
    if (!ep || !season) return null;
    return this.downloadBadge({
      seasonFilter: [season.seasonNumber],
      episodeFilter: ep.episodeNumber,
    });
  });

  private readonly downloadModal = viewChild<DownloadQualityModalComponent>('downloadModal');
  private readonly downloadDetailModal =
    viewChild<DownloadDetailModalComponent>('downloadDetailModal');
  /** Same SSE payload must run handlers once; `media` updates (e.g. after rescan) re-run this effect.
   *  Seeded from the service so a re-created instance doesn't replay an event from before it existed. */
  private lastHandledSseEvent: SseEvent | null = this.sse.lastEvent();

  /** Signal mirror of paramMap: the component is reused across episode URLs, so a snapshot misses changes. */
  private readonly routeParams = toSignal(this.route.paramMap);

  /** Skeleton shape (still vs poster) read off the URL, since `episodeMode` only settles after the season tree loads. */
  protected readonly skeletonEpisode = computed(
    () => !!this.routeParams()?.get('episodeId'),
  );

  private loadedId: number | null = null;

  /** Cached route: coming back from the player repaints the page as it was, so
   *  only what playback changed has to be re-read, plus a forced media refetch. */
  private readonly routeFresh = keepRouteFresh({
    refresh: () => this.refreshOnReturn(),
    scrollKey: () => this.scrollKey(),
    onDetach: () => this.releaseChrome(),
    onAttach: () => this.restoreChrome(),
  });

  /** Last fanart declared, so returning to a cached page can re-declare it. */
  private fanartUrl: string | null = null;

  /** The hero navbar and the backdrop are global state, so a cached page hands
   *  them back on the way out and reclaims them on return. */
  private releaseChrome(): void {
    this.navbarService.leaveHeroPage();
    this.backgroundService.suspend(this);
  }

  private restoreChrome(): void {
    this.backgroundService.set(this, this.fanartUrl);
    const m = this.media();
    if (m) this.applyEpisodeFocus(m, this.route.snapshot.paramMap.get('episodeId'));
    else this.navbarService.enterHeroPage('');
  }

  /** Driven by the route param, not ngOnInit: switching episodes reuses this instance and must not refetch the held series. */
  private readonly routeMediaEffect = effect(() => {
    const params = this.routeParams();
    if (!params) return;
    const id = Number(params.get('id'));
    if (id === this.loadedId) {
      this.trackScroll();
      return;
    }
    this.loadedId = id;
    void this.loadMedia(id);
  });

  /** Retarget scroll memory to the page the params describe and request its offset on return.
   *  Episode-to-episode never detaches the route, so this is the only pass that can retarget the key. */
  private trackScroll(): void {
    const key = this.scrollKey();
    this.scrollMemory.activate(key);
    if (untracked(() => this.navbarService.navigatedBack())) this.scrollMemory.restoreSticky(key);
  }

  /** Syncs episode-focus state with the URL when the media or route params change. */
  private readonly episodeFocusEffect = effect(() => {
    const m = this.media();
    const params = this.routeParams();
    if (!m || !params) return;
    // Seeded stub: the episode is already in place and there is no season tree
    // to resolve against, so resolving now would only report it missing.
    if (m.type === 'series' && !m.seasons) return;
    const idParam = params.get('id');
    const paramId = idParam ? Number(idParam) : NaN;
    if (m.id !== paramId) return;
    this.applyEpisodeFocus(m, params.get('episodeId'));
  });

  /** Series / movie fanart, never the episode still: TMDB stills cap at
   *  ~780×438 and look mushy stretched fullscreen. */
  private readonly backgroundEffect = effect(() => {
    const m = this.media();
    this.fanartUrl = m ? pickFanart(m) : null;
    this.backgroundService.set(this, this.fanartUrl);
  });

  /** React to SSE rescan / import / metadata-refresh events for this media */
  private readonly sseEffect = effect(() => {
    const event = this.sse.lastEvent();
    const m = this.media();
    if (!event || !m) return;
    if ((event['mediaId'] as number) !== m.id) return;
    if (event === this.lastHandledSseEvent) return;
    this.lastHandledSseEvent = event;
    if (event.type === 'rescan.completed' || event.type === 'import.complete') {
      void this.reloadMedia(m.id);
    } else if (event.type === 'metadata.refreshed') {
      void this.reloadMedia(m.id);
      this.toast.success(this.translate.instant('media_detail.refresh_ok'));
    } else if (event.type === 'metadata.failed') {
      this.toast.error(
        (event as { error?: string }).error ?? this.translate.instant('media_detail.refresh_error'),
      );
    }
  });

  /** Arms the page slide for the plain anchors of this page. A card does it
   *  from its own click; a bare `routerLink` has nothing that would. */
  protected readonly armSlide = armPageSlide;

  readonly media = signal<Media | null>(null);
  readonly cast = signal<MediaCastEntry[]>([]);
  readonly crew = signal<MediaCrewEntry[]>([]);
  readonly similar = signal<RelatedMedia[]>([]);
  readonly collection = signal<MediaCollection | null>(null);
  readonly resumeInfo = signal<MediaResumeInfo | null>(null);
  readonly mediaFiles = computed(() => {
    const m = this.media();
    if (!m) return [];
    const list = m.files ?? [];
    // Series files belong to episodes; hide orphans at the root.
    return m.type === 'series' ? [] : list;
  });

  /** Falls back to the file's own duration when the provider never gave a runtime. */
  readonly displayRuntime = computed(() => {
    const m = this.media();
    if (m?.runtime) return m.runtime;
    const seconds = this.mediaFiles()[0]?.streamInfo?.durationSeconds;
    return seconds ? Math.round(seconds / 60) : (m?.runtime ?? null);
  });

  readonly selectedFileId = signal<number | null>(null);
  readonly activeFileId = computed(() => this.selectedFileId() ?? this.mediaFiles()[0]?.id ?? null);
  readonly activeFile = computed(() => {
    const id = this.activeFileId();
    return this.mediaFiles().find((f) => f.id === id) ?? null;
  });

  /** Keep the selection pointing at a file that still exists — validated against
   *  every file (a series' selection is an episode file, absent from `mediaFiles`). */
  private readonly autoSelectFileEffect = effect(() => {
    const all = this.media()?.files ?? [];
    const current = this.selectedFileId();
    if (current != null && all.some((f) => f.id === current)) return;
    this.selectedFileId.set(this.mediaFiles()[0]?.id ?? null);
  });

  // ── Episode full-page mode (when navigating to series/:id/episode/:episodeId) ──
  readonly episodeMode = signal(false);
  readonly focusedEpisode = signal<Episode | null>(null);
  readonly focusedSeason = signal<Season | null>(null);

  /** Centre the "Plus de saison X" rail on the opened episode, catching cards that mount after the block's own centring. */
  private readonly scrollToFocusedEpisodeEffect = effect(() => {
    const active = this.focusedEpisode();
    const season = this.focusedSeason();
    if (!active || !this.episodeMode() || this.episodeView.currentSeasonEpisodes().length < 2) {
      return;
    }
    setTimeout(
      () => centerRailOnCard(`episode-${active.id}`, season ? `season-${season.id}` : undefined),
      30,
    );
  });

  /** Directors for shared header */
  readonly directors = computed(() =>
    this.crew()
      .filter((c) => c.job?.toLowerCase() === 'director')
      .map((c) => c.person.name),
  );

  readonly loading = signal(true);
  readonly notFound = signal(false);
  /** Card-known episode data painted into the header while the media request is in flight, so the poster morph has a target. */
  readonly episodeSeed = signal<HandedEpisode | null>(this.handedEpisode());
  readonly expectedKind = signal<MediaType>('movie');

  readonly qualityProfileOptions = signal<{ id: number; name: string }[]>([]);
  readonly languageProfiles = signal<LanguageProfile[]>([]);
  readonly languageProfileOptions = signal<{ id: number; name: string }[]>([]);
  readonly profilesOptionsLoading = signal(false);
  readonly draftQualityProfileId = signal<number | null>(null);
  readonly draftLanguageProfileId = signal<number | null>(null);
  readonly profilesSaveLoading = signal(false);
  readonly profilesOk = signal('');
  readonly profilesErr = signal('');

  readonly libraries = signal<LibrarySummary[]>([]);
  readonly selectedLibraryId = signal<number | null>(null);
  readonly mediaHasFiles = computed(() => !!this.media()?.files?.length);
  readonly selectedProvider = signal<'tmdb' | 'tvdb' | null>(null);
  readonly libraryPatchSaving = signal(false);
  readonly libraryPatchSaved = signal(false);

  readonly canGrab = computed(() => this.auth.hasPermission('media.grab'));
  readonly canManageSubtitles = computed(() => this.auth.hasPermission('subtitles.manage'));
  readonly canEditProfiles = computed(() => this.auth.hasPermission('media.edit'));
  readonly canDelete = computed(() => this.auth.hasPermission('media.delete'));
  readonly isAdmin = computed(() => this.auth.hasPermission('settings.access'));

  /** No metadata-provider id: title, artwork and provider-derived sections all come from the file. */
  readonly unidentified = computed(() => {
    const m = this.media();
    return !!m && !hasProviderId(m);
  });

  /** Anti-spoiler masks for the focused episode's hero, still and synopsis. */
  readonly episodeSpoilerImage = computed(() =>
    this.focusedEpisodeWatched() === null
      ? false
      : this.spoilers.still(this.focusedEpisodeWatched()!),
  );
  readonly episodeSpoilerOverview = computed(() =>
    this.focusedEpisodeWatched() === null
      ? false
      : this.spoilers.overview(this.focusedEpisodeWatched()!),
  );

  /** Watched state of the focused episode, `null` outside episode mode. */
  private readonly focusedEpisodeWatched = computed(() => {
    const ep = this.focusedEpisode();
    return ep ? this.watched.episodeIds().has(ep.id) : null;
  });

  readonly deleteLoading = signal(false);
  readonly monitoredLoading = signal(false);
  /** Active season tab (series) — first season selected after load */
  readonly activeSeasonId = signal<number | null>(null);
  readonly seasonBusy = signal<number | null>(null);
  readonly episodeBusy = signal<number | null>(null);

  readonly episodeDrawerContext = signal<{ season: Season; episode: Episode } | null>(null);

  /** Series: show only episodes with a file on disk (persisted in localStorage) */
  readonly episodesHasFileOnly = signal(readEpisodesHasFileOnlyFromStorage());

  readonly movieReleasesModal = viewChild<ReleasesModalComponent>('movieReleasesModal');
  readonly episodeReleasesModal = viewChild<ReleasesModalComponent>('episodeReleasesModal');
  readonly seasonReleasesModal = viewChild<ReleasesModalComponent>('seasonReleasesModal');
  readonly profilesModal = viewChild(MediaDetailProfilesModalComponent);
  readonly libraryModal = viewChild(MediaDetailLibraryModalComponent);
  readonly subtitleSection = viewChild(SubtitlesModalComponent);
  private readonly infoHeader = viewChild(MediaInfoHeaderComponent);

  openTracking(scope: TrackingScope): void {
    const id = this.media()?.id;
    if (id == null) return;
    this.trackingModalService.open(id, scope);
  }

  readonly episodeDialogFiles = computed(() => {
    const c = this.episodeDrawerContext();
    const m = this.media();
    if (!c || !m?.files) return [];
    return filesForEpisode(m.files, c.episode.id);
  });

  private readonly scrollMemory = inject(ScrollMemoryService);

  /** Own memory per media and per episode, so back from an episode lands where
   *  it left rather than on the other page's offset. */
  private scrollKey(): string {
    const ep = this.route.snapshot.paramMap.get('episodeId');
    return ep ? `episode-${ep}` : `media-${this.route.snapshot.paramMap.get('id')}`;
  }

  ngOnDestroy() {
    this.backgroundService.release(this);
    // Evicted from the route cache while another page is on screen: the chrome
    // and scroll key already belong to that page, so leave them alone.
    if (this.routeFresh()) return;
    this.scrollMemory.deactivate();
    this.releaseChrome();
  }

  ngOnInit() {
    // Enter hero page immediately (transparent navbar) — title will be set after media loads
    this.navbarService.enterHeroPage('');
    this.expectedKind.set(this.route.snapshot.data['kind'] as MediaType);
    // Load profiles in parallel with media — neither blocks the other
    void this.loadProfiles();
  }

  private async loadProfiles() {
    // Either permission needs the profile options (admins edit inline, requesters fill the request modal).
    if (!this.auth.hasPermission('media.edit') && !this.auth.hasPermission('requests.create'))
      return;
    this.profilesOptionsLoading.set(true);
    try {
      const [q, l, libs] = await Promise.all([
        this.profilesApi.getQualityProfiles(),
        this.profilesApi.getLanguageProfiles(),
        this.librariesApi.listMine(),
      ]);
      this.qualityProfileOptions.set(q.map((p) => ({ id: p.id, name: p.name })));
      this.languageProfiles.set(l);
      this.languageProfileOptions.set(l.map((p) => ({ id: p.id, name: p.name })));
      this.libraries.set(libs);
    } catch {
      // Profiles will just be empty — the page still works
    } finally {
      this.profilesOptionsLoading.set(false);
    }
  }

  /** Paint the episode header from the card handoff: a stub series replaced wholesale when real media lands.
   *  The stub has no `seasons`, which tells the focus effect to leave the seed alone. */
  private seedFromHandedEpisode(mediaId: number): boolean {
    const seed = this.handedEpisode();
    this.episodeSeed.set(seed);
    if (!seed) return false;
    this.media.set({
      id: mediaId,
      type: 'series',
      title: seed.title ?? '',
      monitored: true,
    } as unknown as Media);
    this.episodeMode.set(true);
    this.focusedSeason.set(null);
    // `monitored` is bound straight through to the header, and an undefined here
    // reads as false — flashing an "unmonitored" badge on every seeded load.
    this.focusedEpisode.set({
      id: seed.episodeId,
      stillUrl: seed.stillUrl,
      monitored: true,
    } as unknown as Episode);
    return true;
  }

  private handedEpisode(): HandedEpisode | null {
    const handed = (history.state as { episode?: HandedEpisode & { id: number } })?.episode;
    const param = Number(this.route.snapshot.paramMap.get('episodeId'));
    if (!handed?.stillUrl || handed.id !== param) return null;
    return {
      episodeId: param,
      stillUrl: handed.stillUrl,
      title: handed.title ?? null,
      label: handed.label ?? null,
    };
  }

  private async loadMedia(id: number) {
    const kind = this.route.snapshot.data['kind'] as MediaType;
    // Only back navigation restores the offset; other opens start at the top.
    // Android's back gesture is an imperative `goBack()`, so the router trigger can't be used.
    const wentBack = untracked(() => this.navbarService.navigatedBack());
    this.scrollMemory.activate(this.scrollKey());
    if (!Number.isFinite(id) || id < 1) {
      this.loading.set(false);
      this.notFound.set(true);
      return;
    }

    // Nothing here survives a switch to another title.
    this.notFound.set(false);
    this.cast.set([]);
    this.crew.set([]);
    this.similar.set([]);
    this.collection.set(null);
    this.resumeInfo.set(null);
    this.watched.reset();
    this.selectedFileId.set(null);
    this.activeSeasonId.set(null);

    // Card handoff via router state renders immediately; the fetch below still brings cast/crew/files/seasons.
    const passed = (history.state as { media?: Media })?.media;
    if (passed && passed.id === id && passed.type === kind) {
      this.media.set(passed);
      this.loading.set(false);
    } else if (this.seedFromHandedEpisode(id)) {
      this.loading.set(false);
    } else if (this.media()?.id !== id) {
      this.media.set(null);
      this.loading.set(true);
    }

    try {
      const m = await this.mediaService.getOne(id);
      if (m.type !== kind) {
        void this.router.navigate(['/', m.type === 'movie' ? 'movies' : 'series', m.id]);
        return;
      }
      this.media.set(m);
      // Paint from the cache-served media immediately; the uncacheable
      // playback-state calls below must not gate first paint.
      this.loading.set(false);
      this.openFromQueryParam();
      // Router scroll restoration is 'top', so restore by hand and sticky: late-landing content clamps a one-off scrollTo.
      if (wentBack) this.scrollMemory.restoreSticky(this.scrollKey());
      this.draftQualityProfileId.set(m.qualityProfile?.id ?? null);
      this.draftLanguageProfileId.set(m.languageProfile?.id ?? null);
      this.selectedLibraryId.set(m.libraryId ?? null);
      this.selectedProvider.set(m.preferredProvider ?? null);
      queueMicrotask(() => {
        void this.mediaService
          .getOne(id, { force: true })
          .then((fresh) => {
            if (fresh.type === kind) this.media.set(fresh);
          })
          .catch(() => {
            /* network failure — cached body keeps showing */
          });
      });

      // Provider-derived sections have nothing to fetch for an unidentified title.
      if (hasProviderId(m)) {
        this.mediaService
          .getCast(m.id)
          .then((c) => this.cast.set(c))
          .catch(() => {});
        this.mediaService
          .getCrew(m.id)
          .then((c) => this.crew.set(c))
          .catch(() => {});
        if (m.type === 'movie') {
          this.mediaService
            .getSimilar(m.id)
            .then((s) => this.similar.set(s))
            .catch(() => {});
          this.mediaService
            .getCollection(m.id)
            .then((c) => this.collection.set(c))
            .catch(() => {});
        }
      }
      this.requestFlow.load(m);
      void this.loadPlaybackState(m);
    } catch {
      this.notFound.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** Re-read playback-affected state without touching the cached cast/crew/similar rails. */
  private refreshOnReturn(): void {
    const m = this.media();
    if (!m) return;
    void this.loadPlaybackState(m);
    this.infoHeader()?.reloadPlaybackState();
    void this.mediaService
      .getOne(m.id, { force: true })
      .then((fresh) => {
        if (fresh.id === m.id) this.media.set(fresh);
      })
      .catch(() => {
        /* network failure — the cached page keeps showing */
      });
  }

  /** Resume position, watched episodes and progress from uncacheable /api/playback routes,
   *  kept off the render path and re-run when the page returns on screen. */
  private async loadPlaybackState(m: Media): Promise<void> {
    const [resumeInfo, watchedIds, progress] = await Promise.all([
      this.streamingApi.getMediaResumeInfo(m.id).catch(() => null),
      m.type === 'series'
        ? this.streamingApi.getWatchedEpisodeIds(m.id).catch(() => [] as number[])
        : Promise.resolve([] as number[]),
      m.type === 'series'
        ? this.streamingApi.getEpisodeProgress(m.id).catch(() => ({}) as Record<number, number>)
        : Promise.resolve({} as Record<number, number>),
    ]);
    this.resumeInfo.set(resumeInfo);
    const watchedSet = new Set(watchedIds);
    this.watched.episodeIds.set(watchedSet);
    this.watched.episodeProgress.set(progress);

    // Pre-select the last-played file if available
    if (resumeInfo?.mediaFileId) {
      const files = m.files ?? [];
      if (files.some((f) => f.id === resumeInfo.mediaFileId)) {
        this.selectedFileId.set(resumeInfo.mediaFileId);
      }
    }

    // Preselect the season of the in-progress episode (resumeInfo), else of the first unwatched
    // episode with a file (covers between-episodes, where resumeInfo is null).
    let resumeHandled = false;
    if (m.type === 'series' && m.seasons?.length) {
      let targetSeasonId: number | null = null;
      if (resumeInfo?.episodeId) {
        targetSeasonId =
          m.seasons.find((s) => s.episodes?.some((e) => e.id === resumeInfo.episodeId))?.id ??
          null;
      }
      if (targetSeasonId == null) {
        targetSeasonId =
          m.seasons.find((s) => s.episodes?.some((e) => e.hasFile && !watchedSet.has(e.id)))
            ?.id ?? null;
      }
      if (targetSeasonId != null) {
        this.activeSeasonId.set(targetSeasonId);
        this.persistActiveSeason(targetSeasonId);
        resumeHandled = true;
      }
    }

    if (m.type === 'series' && m.seasons?.length) {
      if (!resumeHandled) this.syncActiveSeasonForSeriesFilter();
    } else {
      this.activeSeasonId.set(null);
    }
  }

  /** Apply episode focus (hero, navbar title) for the episodeId param; flips `notFound` on an unknown episode. */
  private applyEpisodeFocus(m: Media, episodeIdParam: string | null): void {
    if (!episodeIdParam) {
      this.episodeMode.set(false);
      this.focusedSeason.set(null);
      this.focusedEpisode.set(null);
      this.navbarService.enterHeroPage(m.title, m.logoUrl);
      return;
    }
    const episodeId = Number(episodeIdParam);
    let foundSeason: Season | null = null;
    let foundEpisode: Episode | null = null;
    for (const s of m.seasons ?? []) {
      const ep = s.episodes?.find((e) => e.id === episodeId);
      if (ep) {
        foundSeason = s;
        foundEpisode = ep;
        break;
      }
    }
    if (!foundEpisode) {
      this.notFound.set(true);
      return;
    }
    this.notFound.set(false);
    this.episodeMode.set(true);
    this.focusedSeason.set(foundSeason);
    this.focusedEpisode.set(foundEpisode);
    const sn = String(foundSeason!.seasonNumber).padStart(2, '0');
    const en = String(foundEpisode.episodeNumber).padStart(2, '0');
    this.navbarService.enterHeroPage(
      [m.title, `S${sn}:E${en}`, foundEpisode.title].filter(Boolean).join(' - '),
      m.logoUrl,
    );
  }

  backSegment(): string {
    return this.expectedKind() === 'movie' ? 'movies' : 'series';
  }

  openLibraryModal() {
    this.libraryPatchSaved.set(false);
    this.libraryModal()?.showModal();
  }

  async saveLibrary() {
    const m = this.media();
    if (!m) return;
    const libId = this.selectedLibraryId();
    if (libId == null) return;
    const provider = this.selectedProvider();
    const providerChanged = (m.preferredProvider ?? null) !== provider;
    this.libraryPatchSaving.set(true);
    this.libraryPatchSaved.set(false);
    try {
      let updated = libId !== m.libraryId ? await this.mediaService.patchLibrary(m.id, libId) : m;
      if (providerChanged) {
        updated = await this.mediaService.update(m.id, {
          preferredProvider: provider,
        });
      }
      this.media.set(updated);
      if (updated.type === 'series') this.syncActiveSeasonForSeriesFilter();
      this.libraryPatchSaved.set(true);
      setTimeout(() => this.libraryPatchSaved.set(false), 3000);
    } finally {
      this.libraryPatchSaving.set(false);
    }
  }

  async saveProfiles() {
    const m = this.media();
    if (!m) return;
    this.profilesSaveLoading.set(true);
    this.profilesOk.set('');
    this.profilesErr.set('');
    try {
      const updated = await this.mediaService.patchProfiles(m.id, {
        qualityProfileId: this.draftQualityProfileId(),
        languageProfileId: this.draftLanguageProfileId(),
      });
      this.media.set(updated);
      if (updated.type === 'series') this.syncActiveSeasonForSeriesFilter();
      this.draftQualityProfileId.set(updated.qualityProfile?.id ?? null);
      this.draftLanguageProfileId.set(updated.languageProfile?.id ?? null);
      this.profilesOk.set(this.translate.instant('media_detail.profiles_saved'));
    } catch (err: unknown) {
      this.profilesErr.set(serverMessage(err, this.translate, 'media_detail.profiles_save_error'));
    } finally {
      this.profilesSaveLoading.set(false);
    }
  }

  async toggleMonitored() {
    const ep = this.focusedEpisode();
    if (ep) {
      // Episode mode: toggle episode monitoring
      this.monitoredLoading.set(true);
      try {
        await this.mediaService.updateEpisodeMonitored(ep.id, !ep.monitored);
        this.focusedEpisode.set({ ...ep, monitored: !ep.monitored });
      } finally {
        this.monitoredLoading.set(false);
      }
      return;
    }
    const m = this.media();
    if (!m) return;
    this.monitoredLoading.set(true);
    try {
      const updated = await this.mediaService.toggleMonitored(m.id, !m.monitored);
      this.media.set(updated);
      if (updated.type === 'series') {
        this.syncActiveSeasonForSeriesFilter();
        const open = this.episodeDrawerContext();
        if (open) {
          const s = updated.seasons?.find((x) => x.id === open.season.id);
          const e = s?.episodes.find((x) => x.id === open.episode.id);
          if (s && e) this.episodeDrawerContext.set({ season: s, episode: e });
        }
      }
    } finally {
      this.monitoredLoading.set(false);
    }
  }

  async deleteMedia() {
    const m = this.media();
    if (!m) return;
    const messageKey = m.folderName
      ? 'media_detail.confirm_delete'
      : 'media_detail.delete_no_folder';
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant(messageKey, { title: m.title }),
        variant: 'danger',
      }))
    )
      return;
    this.deleteLoading.set(true);
    try {
      await this.mediaService.delete(m.id);
      this.toast.success(this.translate.instant('media_detail.delete_success'));
      void this.router.navigate(['/']);
    } finally {
      this.deleteLoading.set(false);
    }
  }

  openProfilesModal() {
    this.profilesOk.set('');
    this.profilesErr.set('');
    this.profilesModal()?.showModal();
  }

  async refreshMetadata() {
    const m = this.media();
    if (!m) return;
    // Fire-and-forget. Backend emits SSE `metadata.refreshed` / `metadata.failed`
    // which the sseEffect below catches to toast + reload the media row.
    try {
      const ep = this.focusedEpisode();
      if (ep) {
        await this.mediaService.refreshEpisodeMetadata(m.id, ep.id);
      } else {
        await this.mediaService.refreshMetadata(m.id);
      }
      this.toast.success(this.translate.instant('media_detail.refresh_launched'));
    } catch (err: unknown) {
      this.toast.error(serverMessage(err, this.translate, 'media_detail.refresh_error'));
    }
  }

  /** Targets chosen from a season, the series or an episode row; consumed by the next quality pick. */
  private pendingDownloads: (DownloadTarget & { watched: boolean })[] | null = null;

  private downloadTargets(seasons: Season[]): (DownloadTarget & { watched: boolean })[] {
    const m = this.media();
    if (!m) return [];
    const watched = this.watched.episodeIds();
    const targets: (DownloadTarget & { watched: boolean })[] = [];
    for (const s of seasons) {
      for (const ep of s.episodes) {
        const file = m.files?.find((f) => f.episodeId === ep.id);
        if (!file || targets.some((t) => t.mediaFileId === file.id)) continue;
        targets.push({
          mediaId: m.id,
          episodeId: ep.id,
          mediaFileId: file.id,
          title: m.title,
          episodeLabel: episodeLabel(s.seasonNumber, ep.episodeNumber, ep.title),
          seasonNumber: s.seasonNumber,
          episodeNumber: ep.episodeNumber,
          posterUrl: m.posterUrl,
          type: m.type,
          watched: watched.has(ep.id),
        });
      }
    }
    return targets;
  }

  private openBatch(targets: (DownloadTarget & { watched: boolean })[]) {
    if (!targets.length) return;
    this.pendingDownloads = targets;
    const unwatched = targets.filter((t) => !t.watched).length;
    void this.downloadModal()?.openBatch(targets[0].mediaFileId!, { all: targets.length, unwatched });
  }

  downloadSeason(season: Season) {
    this.openBatch(this.downloadTargets([season]));
  }

  /** Episodes picked by hand: never filtered by watched state. */
  downloadSeasons(seasons: Season[]) {
    this.openBatch(this.downloadTargets(seasons).map((t) => ({ ...t, watched: false })));
  }

  downloadSeries() {
    this.openBatch(this.downloadTargets((this.media()?.seasons ?? []).filter((s) => s.seasonNumber > 0)));
  }

  downloadEpisode(season: Season, episode: Episode) {
    const [target] = this.downloadTargets([{ ...season, episodes: [episode] }]);
    if (!target) return;
    this.pendingDownloads = [{ ...target, watched: false }];
    void this.downloadModal()?.open(target.mediaFileId!);
  }

  openDownloadModal() {
    this.pendingDownloads = null;
    const fileId = this.episodeMode() ? this.episodeView.episodeActiveFileId() : this.activeFileId();
    if (fileId) this.downloadModal()?.open(fileId);
  }

  openDownloadDetailModal() {
    this.downloadDetailModal()?.open();
  }

  openSubtitles() {
    this.subtitleSection()?.show();
  }

  async onDownload(ev: { mediaFileId: number; quality: string; unwatchedOnly: boolean }) {
    const pending = this.pendingDownloads;
    this.pendingDownloads = null;
    if (pending) {
      const targets = ev.unwatchedOnly ? pending.filter((t) => !t.watched) : pending;
      const { started, failed, skipped } = await this.downloadManager.createMany(targets, ev.quality);
      if (started) this.toast.success(this.translate.instant('downloads.started'));
      else if (failed) this.toast.error(this.translate.instant('downloads.error'));
      else this.toast.info(this.translate.instant(nothingStartedKey(skipped, targets.length)));
      return;
    }
    try {
      const m = this.media();
      const title = m?.title ?? 'Téléchargement';
      const ep = this.focusedEpisode();
      const s = this.focusedSeason();
      let episode: string | undefined;
      if (s && ep) {
        episode = episodeLabel(s.seasonNumber, ep.episodeNumber, ep.title);
      }
      await this.downloadManager.createDownload(ev.mediaFileId, ev.quality, title, episode, {
        mediaId: m?.id,
        posterUrl: m?.posterUrl,
        type: m?.type,
        episodeId: ep?.id,
        seasonNumber: s?.seasonNumber,
        episodeNumber: ep?.episodeNumber,
      });
      this.toast.success(this.translate.instant('downloads.started'));
    } catch {
      this.toast.error(this.translate.instant('downloads.error'));
    }
  }

  /** Native <dialog>: showModal() gives focus trap, Tab cycling and Escape for free. */
  private readonly analyzeDialog = viewChild<ElementRef<HTMLDialogElement>>('analyzeDialog');
  private readonly firstAnalyzeOption =
    viewChild<ElementRef<HTMLInputElement>>('firstAnalyzeOption');

  /** Opens a modal from `?action=` so a media card can reach it without hoisting modals to the layout.
   *  The param is stripped once consumed so a reload doesn't reopen it. */
  private openFromQueryParam() {
    const action = this.route.snapshot.queryParamMap.get('action');
    if (!action) return;
    const m = this.media();
    if (!m) return;
    const openers: Record<string, () => void> = {
      identify: () => this.openIdentifyModal(),
      profiles: () => this.openProfilesModal(),
      library: () => this.openLibraryModal(),
      subtitles: () => this.openSubtitles(),
      analyze: () => this.analyze.open(),
      refresh: () => void this.refreshMetadata(),
      tracking: () =>
        this.openTracking(m.type === 'movie' ? { kind: 'movie' } : { kind: 'series' }),
    };
    const open = openers[action];
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { action: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    if (open) queueMicrotask(open);
  }

  openIdentifyModal() {
    const m = this.media();
    if (!m) return;
    this.identifyModalService.open({
      mediaId: m.id,
      mediaType: m.type,
      title: m.title,
      year: m.year ?? null,
      path: m.path ?? null,
      tmdbId: m.tmdbId ?? null,
      tvdbId: m.tvdbId ?? null,
      imdbId: m.imdbId ?? null,
    });
  }

  /** The title, art and whole episode tree change, so the page reloads rather
   *  than patching the row — same path the rescan takes. */
  /** Dialog reports via a counter; the first read is ignored since an effect fires on creation. */
  private seenIdentified = -1;
  private readonly identifiedEffect = effect(() => {
    const n = this.identifyModalService.identified();
    if (this.seenIdentified < 0) {
      this.seenIdentified = n;
      return;
    }
    if (n === this.seenIdentified) return;
    this.seenIdentified = n;
    this.onIdentified();
  });

  onIdentified() {
    const m = this.media();
    if (m) void this.reloadMedia(m.id);
  }

  /** Re-read media after an external change; forced because server events invalidate no cache entry. */
  private async reloadMedia(mediaId: number) {
    try {
      const updated = await this.mediaService.getOne(mediaId, { force: true });
      this.media.set(updated);
      if (updated.type === 'series') this.syncActiveSeasonForSeriesFilter();
      // Re-resolve the focused episode against the refreshed tree.
      const ep = this.focusedEpisode();
      if (ep) {
        for (const s of updated.seasons ?? []) {
          const fresh = s.episodes?.find((e) => e.id === ep.id);
          if (fresh) {
            this.focusedSeason.set(s);
            this.focusedEpisode.set(fresh);
            break;
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  selectSeason(seasonId: number) {
    this.activeSeasonId.set(seasonId);
    this.persistActiveSeason(seasonId);
  }

  private persistActiveSeason(seasonId: number | null) {
    const m = this.media();
    if (!m) return;
    try {
      if (seasonId != null) {
        sessionStorage.setItem(`fliks.season.${m.id}`, String(seasonId));
      } else {
        sessionStorage.removeItem(`fliks.season.${m.id}`);
      }
    } catch {
      /* private mode */
    }
  }

  private restoreActiveSeason(): number | null {
    const m = this.media();
    if (!m) return null;
    try {
      const v = sessionStorage.getItem(`fliks.season.${m.id}`);
      return v ? Number(v) : null;
    } catch {
      return null;
    }
  }

  setEpisodesHasFileOnly(value: boolean) {
    this.episodesHasFileOnly.set(value);
    try {
      localStorage.setItem(LS_EPISODES_HAS_FILE_ONLY, value ? '1' : '0');
    } catch {
      /* private mode / quota */
    }
    this.syncActiveSeasonForSeriesFilter();
  }

  /** Garde activeSeasonId sur une saison visible (onglets) quand le filtre disque est actif. */
  private syncActiveSeasonForSeriesFilter() {
    const m = this.media();
    if (m?.type !== 'series' || !m.seasons?.length) return;
    const visible = seasonsVisibleWithDiskFilter(m, this.episodesHasFileOnly());
    if (!visible.length) {
      this.activeSeasonId.set(null);
      return;
    }

    // Check query param ?season=NUMBER for deep-link from episode page
    const qpSeason = Number(this.route.snapshot.queryParamMap.get('season'));
    if (qpSeason) {
      const match = visible.find((s) => s.seasonNumber === qpSeason);
      if (match) {
        this.activeSeasonId.set(match.id);
        this.persistActiveSeason(match.id);
        return;
      }
    }

    // Restore from sessionStorage (browser back button)
    const stored = this.restoreActiveSeason();
    if (stored != null && visible.some((s) => s.id === stored)) {
      this.activeSeasonId.set(stored);
      return;
    }

    const cur = this.activeSeasonId();
    if (cur == null || !visible.some((s) => s.id === cur)) {
      this.activeSeasonId.set(visible[0].id);
    }
  }

  filteredSeasonEpisodes(season: Season): Episode[] {
    const m = this.media();
    if (!m) return season.episodes;
    return filterSeasonEpisodesOnDisk(season, this.episodesHasFileOnly());
  }

  activeSeason(m: Media): Season | null {
    const id = this.activeSeasonId();
    if (!m.seasons?.length || id == null) return null;
    return m.seasons.find((s) => s.id === id) ?? null;
  }

  openEpisodeDetailDrawer(season: Season, episode: Episode) {
    const current = this.episodeDrawerContext();
    // Toggle: close if clicking the same episode
    if (current?.episode.id === episode.id) {
      this.episodeDrawerContext.set(null);
    } else {
      this.episodeDrawerContext.set({ season, episode });
    }
  }

  closeEpisodeInline() {
    this.episodeDrawerContext.set(null);
  }

  onEpisodeDialogToggleMonitored() {
    const c = this.episodeDrawerContext();
    if (c) void this.toggleEpisodeMonitored(c.season.id, c.episode);
  }

  onEpisodeDialogLoadReleases() {
    const c = this.episodeDrawerContext();
    const media = this.media();
    if (c && media) {
      void this.grabs.loadEpisodeReleases(media.id, c.episode.id);
    }
  }

  async toggleSeasonMonitored(season: Season) {
    if (!this.isAdmin()) return;
    this.seasonBusy.set(season.id);
    try {
      const updated = await this.mediaService.updateSeasonMonitored(season.id, !season.monitored);
      const m = this.media();
      if (!m?.seasons) return;
      const nextSeasons = m.seasons.map((s) =>
        s.id === updated.id
          ? {
              ...s,
              monitored: updated.monitored,
              episodes: s.episodes.map((e) => ({
                ...e,
                monitored: updated.monitored,
              })),
            }
          : s,
      );
      this.media.set({ ...m, seasons: nextSeasons });
      this.syncActiveSeasonForSeriesFilter();
      const open = this.episodeDrawerContext();
      if (open?.season.id === updated.id) {
        const s = nextSeasons.find((x) => x.id === updated.id);
        const e = s?.episodes.find((x) => x.id === open.episode.id);
        if (s && e) this.episodeDrawerContext.set({ season: s, episode: e });
      }
    } finally {
      this.seasonBusy.set(null);
    }
  }

  async toggleEpisodeMonitored(seasonId: number, episode: Episode) {
    if (!this.isAdmin()) return;
    this.episodeBusy.set(episode.id);
    try {
      const updated = await this.mediaService.updateEpisodeMonitored(
        episode.id,
        !episode.monitored,
      );
      const m = this.media();
      if (!m?.seasons) return;
      const nextSeasons = m.seasons.map((s) =>
        s.id === seasonId
          ? {
              ...s,
              episodes: s.episodes.map((e) =>
                e.id === updated.id ? { ...e, monitored: updated.monitored } : e,
              ),
            }
          : s,
      );
      this.media.set({ ...m, seasons: nextSeasons });
      this.syncActiveSeasonForSeriesFilter();
      const open = this.episodeDrawerContext();
      if (open?.episode.id === updated.id) {
        const s = nextSeasons.find((x) => x.id === open.season.id);
        const e = s?.episodes.find((x) => x.id === updated.id);
        if (s && e) this.episodeDrawerContext.set({ season: s, episode: e });
      }
    } finally {
      this.episodeBusy.set(null);
    }
  }

  reloadSubtitles() {
    const m = this.media();
    if (m) void this.subtitleSection()?.loadSubtitles(m.id);
  }

  async deleteFile(fileId: number, deleteOnDisk: boolean) {
    const m = this.media();
    if (!m) return;
    try {
      await this.mediaService.deleteFile(m.id, fileId, deleteOnDisk);
      // Not a local splice: the server also flips the episode's `hasFile`, which
      // the season tree renders from.
      await this.reloadMedia(m.id);
    } catch {
      // ignore
    }
  }

  // ---- Re-request (user-facing): UX gate only, backend dedups ----

  private readonly requestModal = viewChild<RequestModalComponent>('requestModal');
  private readonly addToPlaylist = inject(AddToPlaylistService);

  /** Open the "add to playlist" dialog: the focused episode when browsing an
   *  episode, otherwise the movie or the whole series (`mediaId`). */
  protected openAddToPlaylist() {
    const m = this.media();
    if (!m) return;
    const ep = this.episodeMode() ? this.focusedEpisode() : null;
    this.addToPlaylist.open(ep ? { episodeId: ep.id } : { mediaId: m.id });
  }

  private readonly recommend = inject(RecommendService);

  /** Recommend the current title to another member: the focused episode when
   *  browsing an episode, otherwise the movie or the whole series. */
  protected openRecommend() {
    const m = this.media();
    if (!m) return;
    const ep = this.episodeMode() ? this.focusedEpisode() : null;
    this.recommend.open(ep ? { mediaId: m.id, episodeId: ep.id } : { mediaId: m.id });
  }

  // ── Likes ──
  recommendSeason(seasonId: number): void {
    const m = this.media();
    if (!m) return;
    this.recommend.open({ mediaId: m.id, seasonId });
  }

}
