import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type WritableSignal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { IdentifyModalService } from '../../core/services/identify-modal.service';
import { TrackingModalService } from '../../core/services/tracking-modal.service';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
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
import {
  MediaDetailReleasePickerService,
  MovieRelease,
} from './media-detail-release-picker.service';
import {
  ReleaseSearchStreamService,
  type IndexerRosterEntry,
} from './release-search-stream.service';
import { AuthService } from '../../core/services/auth.service';
import { SpoilerService } from '../../core/services/spoiler.service';
import { ProfilesService, LanguageProfile } from '../../core/services/api/profiles.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { NavbarService } from '../../core/services/navbar.service';
import { BackgroundService } from '../../core/services/background.service';
import {
  StreamingApiService,
  MediaResumeInfo,
} from '../../core/services/api/streaming-api.service';
import { MarkersApiService } from '../../core/services/api/markers-api.service';
import { RequestsService, TitleRequestState } from '../../core/services/api/requests.service';
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
import { LikesApiService, LikeState } from '../../core/services/api/likes-api.service';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { CollapsibleSectionComponent } from '../../shared/components/collapsible-section/collapsible-section';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { DownloadQualityModalComponent } from '../../shared/components/download-quality-modal/download-quality-modal';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import { DownloadDetailModalComponent } from '../../shared/components/download-detail-modal/download-detail-modal';
import { collectScopedLeaves, describeDownload } from '../../shared/utils/download-format';
import { TvService } from '../../core/services/tv.service';
import { DownloadProgressService } from '../../core/services/download-progress.service';
import {
  episodeBadgeLabel,
  filesForEpisode,
  filterSeasonEpisodesOnDisk,
  hideShadowedEpisodes,
  seasonsVisibleWithDiskFilter,
} from './media-detail.utils';
import type { MediaFileRow } from './media-detail.utils';
import { isUnprofiledReleaseError, releaseGrabBody } from './media-detail-release.utils';
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

const LS_EPISODES_HAS_FILE_ONLY = 'fliks.mediaDetail.episodesHasFileOnly';

function readEpisodesHasFileOnlyFromStorage(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(LS_EPISODES_HAS_FILE_ONLY) === '1';
  } catch {
    return false;
  }
}

/** Season / episode a grab targets, matching the leaf its download lands under.
 *  Empty for a movie, or a whole-series grab with no season scope. */
type GrabScope = { seasonNumber?: number; episodeNumber?: number };

/** What a card can hand an episode page before its media request lands. */
interface HandedEpisode {
  episodeId: number;
  stillUrl: string;
  title: string | null;
  label: string | null;
}

/** How long a successful grab keeps the search phase while the download
 *  client's first tick makes its way over SSE. */
const GRAB_HANDOFF_MS = 8000;

@Component({
  selector: 'app-media-detail',
  imports: [
    ModalFooterComponent,
    ModalHeaderComponent,
    CachedSrcDirective,
    TranslateModule,
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
  changeDetection: ChangeDetectionStrategy.OnPush,
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

  /** Live download progress for the media on screen (null when not
   *  downloading). Fed by `download.progress` SSE + a one-shot seed on load. */
  readonly activeDownload = computed(() => {
    const m = this.media();
    return m ? (this.downloadProgress.progress().get(m.id) ?? null) : null;
  });

  /**
   * The header's download chip. One download shows its own state and percent;
   * several show how many there are and open the modal for the breakdown —
   * folding their states into one label read "stalled" for a whole show
   * whenever a single episode was, and averaged percentages that belong to
   * different files.
   *
   * Downloads only: the monitored/unmonitored state has its own chip in the
   * metadata row and its entry in the actions menu, and on an ongoing series it
   * would otherwise sit in the header for the life of the show.
   */
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
    };
  }

  /** Whole-media download progress, on the movie/series header. */
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

  /**
   * Signal mirror of the route's paramMap. Angular reuses this component when
   * navigating between two `series/:id/episode/:episodeId` URLs, so a plain
   * snapshot read in ngOnInit would miss subsequent param changes.
   */
  private readonly routeParams = toSignal(this.route.paramMap);

  /** An episode page heroes a landscape still, a title page a 2:3 poster, so the
   *  skeleton has to know which before the data lands. Read off the URL —
   *  `episodeMode` only settles once the season tree is in. */
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

  /** Backdrop pick held across a detach so the page comes back on the same
   *  image instead of re-randomising from the pool. */
  private parkedBackground: string | null = null;

  /** The hero navbar and page backdrop are global state, so a cached page has
   *  to hand them back on the way out and reclaim them on return. */
  private releaseChrome(): void {
    this.parkedBackground = this.backgroundService.url();
    this.navbarService.leaveHeroPage();
    this.backgroundService.clear();
  }

  private restoreChrome(): void {
    this.backgroundService.setBackground(this.parkedBackground);
    const m = this.media();
    if (m) this.applyEpisodeFocus(m, this.route.snapshot.paramMap.get('episodeId'));
    else this.navbarService.enterHeroPage('');
  }

  /**
   * Driven by the route param rather than ngOnInit: switching episodes reuses
   * this instance, and the series it already holds must not be refetched.
   */
  private readonly routeMediaEffect = effect(() => {
    const params = this.routeParams();
    if (!params) return;
    const id = Number(params.get('id'));
    if (id === this.loadedId) return;
    this.loadedId = id;
    void this.loadMedia(id);
  });

  /**
   * Keep the episode-focus state in sync with the URL whenever either the
   * loaded media or the route params change.
   */
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

  /**
   * Drive the global page background from the currently-focused media.
   *
   * We always pull from the *series / movie* fanart pool (never the
   * episode still): TMDB stills cap at ~780×438 and look mushy when
   * stretched fullscreen. The pool is `[fanartUrl,
   * ...additionalFanartUrls]`; one entry is picked at random when the
   * page loads and stays put — no auto-rotation.
   */
  private readonly backgroundEffect = effect(() => {
    const m = this.media();
    if (!m) {
      this.backgroundService.clear();
      return;
    }
    const pool = [m.fanartUrl, ...(m.additionalFanartUrls ?? [])].filter((u): u is string => !!u);
    if (pool.length === 0) {
      this.backgroundService.clear();
      return;
    }
    this.backgroundService.setBackgrounds(pool);
  });

  /** React to SSE rescan + metadata-refresh events for this media */
  private readonly sseEffect = effect(() => {
    const event = this.sse.lastEvent();
    const m = this.media();
    if (!event || !m) return;
    if ((event['mediaId'] as number) !== m.id) return;
    if (event === this.lastHandledSseEvent) return;
    this.lastHandledSseEvent = event;
    if (event.type === 'rescan.completed') {
      void this.reloadAfterRescan(m.id);
    } else if (event.type === 'metadata.refreshed') {
      void this.reloadAfterRescan(m.id);
      this.toast.success(this.translate.instant('media_detail.refresh_ok'));
    } else if (event.type === 'metadata.failed') {
      this.toast.error(
        (event as { error?: string }).error ?? this.translate.instant('media_detail.refresh_error'),
      );
    }
  });

  readonly media = signal<Media | null>(null);
  readonly cast = signal<MediaCastEntry[]>([]);
  readonly crew = signal<MediaCrewEntry[]>([]);
  readonly similar = signal<RelatedMedia[]>([]);
  readonly collection = signal<MediaCollection | null>(null);
  readonly resumeInfo = signal<MediaResumeInfo | null>(null);
  readonly watchedEpisodeIds = signal<Set<number>>(new Set());
  readonly episodeProgress = signal<Record<number, number>>({});
  readonly mediaFiles = computed(() => {
    const m = this.media();
    if (!m) return [];
    const list = m.files ?? [];
    // Series files always belong to an episode; the root page never has
    // a "main file" to display, so don't surface orphans here even if
    // older rows leaked them through.
    return m.type === 'series' ? [] : list;
  });

  /**
   * For a series, true iff every downloaded episode in a non-special season
   * (seasonNumber > 0, hasFile=true) is marked as watched. Drives the series
   * root "watched" toggle and stays in sync with per-episode toggles through
   * `watchedEpisodeIds`.
   */
  readonly seriesFullyWatched = computed(() => {
    const m = this.media();
    if (m?.type !== 'series' || !m.seasons?.length) return false;
    const watched = this.watchedEpisodeIds();
    let total = 0;
    for (const s of m.seasons) {
      if (!s.seasonNumber || s.seasonNumber <= 0) continue;
      for (const ep of s.episodes ?? []) {
        if (!ep.hasFile) continue;
        total++;
        if (!watched.has(ep.id)) return false;
      }
    }
    return total > 0;
  });
  readonly selectedFileId = signal<number | null>(null);
  readonly activeFileId = computed(() => this.selectedFileId() ?? this.mediaFiles()[0]?.id ?? null);
  readonly activeFile = computed(() => {
    const id = this.activeFileId();
    return this.mediaFiles().find((f) => f.id === id) ?? null;
  });

  /** Auto-select first file when mediaFiles change and no selection exists */
  private readonly autoSelectFileEffect = effect(() => {
    const files = this.mediaFiles();
    const current = this.selectedFileId();
    if (files.length && (!current || !files.some((f) => f.id === current))) {
      this.selectedFileId.set(files[0].id);
    }
  });

  // ── Episode full-page mode (when navigating to series/:id/episode/:episodeId) ──
  readonly episodeMode = signal(false);
  readonly focusedEpisode = signal<Episode | null>(null);
  readonly focusedSeason = signal<Season | null>(null);

  readonly episodeFiles = computed<MediaFileRow[]>(() => {
    const ep = this.focusedEpisode();
    const m = this.media();
    if (!ep || !m?.files) return [];
    return filesForEpisode(m.files, ep.id);
  });

  /**
   * On show load we preselect `selectedFileId` to the show-level resume file
   * (e.g. the in-progress episode). That id doesn't belong to the focused
   * episode on E-detail pages — keep it only when it matches one of the
   * focused episode's files, otherwise fall back to the first episode file.
   */
  readonly episodeActiveFileId = computed(() => {
    const files = this.episodeFiles();
    const current = this.selectedFileId();
    if (current != null && files.some((f) => f.id === current)) return current;
    return files[0]?.id ?? null;
  });

  readonly episodeActiveFile = computed(() => {
    const id = this.episodeActiveFileId();
    return this.episodeFiles().find((f) => f.id === id) ?? null;
  });

  readonly episodeLabel = computed(() => {
    const ep = this.focusedEpisode();
    const s = this.focusedSeason();
    if (!ep || !s) return null;
    const sn = String(s.seasonNumber).padStart(2, '0');
    const start = String(ep.episodeNumber).padStart(2, '0');
    const epPart =
      ep.endEpisodeNumber != null && ep.endEpisodeNumber > ep.episodeNumber
        ? `E${start}-E${String(ep.endEpisodeNumber).padStart(2, '0')}`
        : `E${start}`;
    const title = this.spoilers.title(
      this.watchedEpisodeIds().has(ep.id),
      episodeBadgeLabel(ep),
      ep.title ?? '',
    );
    return `S${sn}:${epPart} - ${title}`;
  });

  readonly episodeDateLabel = computed(() => {
    const ep = this.focusedEpisode();
    if (!ep?.airDate) return null;
    return new Date(ep.airDate).toLocaleDateString(this.translate.currentLang || undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  });

  /**
   * Runtime (minutes) to show on the episode detail page. Priority:
   *   1. The actual file duration from ffprobe (accurate for multi-episode
   *      files where TMDB's per-episode runtime understates reality).
   *   2. Sum of per-episode runtimes for the range (if `endEpisodeNumber` set).
   *   3. Plain `ep.runtime` from the provider.
   */
  readonly episodeDisplayRuntime = computed<number | null>(() => {
    const ep = this.focusedEpisode();
    if (!ep) return null;

    const file = this.episodeActiveFile();
    const fileDur = file?.streamInfo?.durationSeconds;
    if (fileDur && fileDur > 0) return Math.round(fileDur / 60);

    const end = ep.endEpisodeNumber;
    if (end != null && end > ep.episodeNumber) {
      const season = this.focusedSeason();
      let total = 0;
      for (let n = ep.episodeNumber; n <= end; n++) {
        const e = season?.episodes?.find((x) => x.episodeNumber === n);
        if (e?.runtime) total += e.runtime;
      }
      if (total > 0) return total;
    }

    return ep.runtime ?? null;
  });

  readonly episodeSeriesRoute = computed(() => {
    const m = this.media();
    return m ? ['/series', String(m.id)] : ['/series'];
  });

  /**
   * Episodes of the focused season — powers the "Plus de saison X" block on
   * the episode detail page. Includes the current episode so the scroller
   * can center on it via {@link scrollToFocusedEpisodeEffect}.
   */
  readonly currentSeasonEpisodes = computed<Episode[]>(() => {
    const s = this.focusedSeason();
    return hideShadowedEpisodes(s?.episodes ?? []);
  });

  /**
   * Seasons rendered as cards under the "more from season N" row on the
   * episode detail page. Keeps the focused season in place — highlighted, so
   * the row doubles as a position indicator. Empty seasons drop out: no
   * episodes, no link target.
   */
  readonly seasonsRow = computed<Season[]>(() => {
    const m = this.media();
    if (!m?.seasons || !this.focusedSeason()) return [];
    return m.seasons
      .filter((s) => (s.episodes?.length ?? 0) > 0)
      .slice()
      .sort((a, b) => a.seasonNumber - b.seasonNumber);
  });

  /** Route to the first episode of `season` so a click jumps the user
   *  into that season's context without an intermediate landing page. */
  seasonLink(m: Media, season: Season): string[] | null {
    const first = season.episodes?.[0];
    if (!first) return null;
    return ['/series', String(m.id), 'episode', String(first.id)];
  }

  /** True iff every downloaded episode of `season` is watched. Drives the
   *  watch/unwatch label on the season card menu and the card's watched badge. */
  seasonFullyWatched(season: Season): boolean {
    const watched = this.watchedEpisodeIds();
    let total = 0;
    for (const ep of season.episodes ?? []) {
      if (!ep.hasFile) continue;
      total++;
      if (!watched.has(ep.id)) return false;
    }
    return total > 0;
  }

  /**
   * When the focused episode changes on the episode detail page, center the
   * "Plus de saison X" scroller on its card. The setTimeout lets the card and
   * its scroll container mount through app-media-detail-seasons →
   * app-horizontal-scroller → ng-content before we measure — they can take a
   * change-detection pass or two to settle.
   */
  private readonly scrollToFocusedEpisodeEffect = effect(() => {
    const active = this.focusedEpisode();
    if (!active || !this.episodeMode() || this.currentSeasonEpisodes().length < 2) {
      return;
    }
    setTimeout(() => this.scrollToEpisode(active.id), 30);
  });

  private scrollToEpisode(epId: number): void {
    const el = document.getElementById(`episode-${epId}`);
    if (!el) return;
    const scroller = this.findHorizontalScrollParent(el);
    if (!scroller) return;
    const elRect = el.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const target =
      scroller.scrollLeft +
      (elRect.left - scrollerRect.left) -
      scroller.clientWidth / 2 +
      el.offsetWidth / 2;
    scroller.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }

  private findHorizontalScrollParent(el: HTMLElement): HTMLElement | null {
    let cur: HTMLElement | null = el.parentElement;
    while (cur) {
      if (/(auto|scroll)/.test(getComputedStyle(cur).overflowX)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /**
   * Episode that the header's "Play" button will launch:
   *   1. resume target (in-progress state)
   *   2. first unwatched episode with a file, in season/episode order
   *   3. first episode with a file (all episodes watched)
   * Seasons with `seasonNumber <= 0` (specials) are skipped.
   */
  readonly nextPlayEpisode = computed<{
    episode: Episode;
    season: Season;
    file: { id: number };
  } | null>(() => {
    const m = this.media();
    if (m?.type !== 'series' || !m.seasons?.length) return null;

    const seasons = [...m.seasons]
      .filter((s) => (s.seasonNumber ?? 0) > 0)
      .sort((a, b) => (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0));

    const resolveFile = (epId: number) => {
      const files = filesForEpisode(m.files, epId);
      return files[0] ?? null;
    };

    // 1. Resume target
    const info = this.resumeInfo();
    if (info?.episodeId) {
      for (const s of seasons) {
        const ep = s.episodes?.find((e) => e.id === info.episodeId);
        if (ep) {
          const file = info.mediaFileId ? { id: info.mediaFileId } : resolveFile(ep.id);
          if (file) return { episode: ep, season: s, file };
        }
      }
    }

    const watched = this.watchedEpisodeIds();

    // 2. First unwatched with file
    for (const s of seasons) {
      const eps = [...(s.episodes ?? [])].sort(
        (a, b) => (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0),
      );
      for (const ep of eps) {
        if (!ep.hasFile || watched.has(ep.id)) continue;
        const file = resolveFile(ep.id);
        if (file) return { episode: ep, season: s, file };
      }
    }

    // 3. First episode with file (series fully watched)
    for (const s of seasons) {
      const eps = [...(s.episodes ?? [])].sort(
        (a, b) => (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0),
      );
      for (const ep of eps) {
        if (!ep.hasFile) continue;
        const file = resolveFile(ep.id);
        if (file) return { episode: ep, season: s, file };
      }
    }

    return null;
  });

  /** Resume episode label for series header (e.g. "S01:E03 - Title") */
  readonly resumeEpisodeLabel = computed(() => {
    const ctx = this.nextPlayEpisode();
    if (!ctx) return null;
    const sn = String(ctx.season.seasonNumber).padStart(2, '0');
    const en = String(ctx.episode.episodeNumber).padStart(2, '0');
    return `S${sn}:E${en} - ${ctx.episode.title ?? ''}`;
  });

  readonly nextPlayEpisodeId = computed(() => this.nextPlayEpisode()?.episode.id);
  readonly nextPlayMediaFileId = computed(() => this.nextPlayEpisode()?.file.id);

  /** Directors for shared header */
  readonly directors = computed(() =>
    this.crew()
      .filter((c) => c.job?.toLowerCase() === 'director')
      .map((c) => c.person.name),
  );

  readonly loading = signal(true);
  readonly notFound = signal(false);
  /**
   * What the card that opened this page knew about the episode. The page paints
   * its real header from it while the media request is in flight, the same way
   * a movie paints from the Media it is handed: the poster morph captures the
   * new state one frame after the route swap, and a header that arrives later
   * has no half of the pair to offer.
   */
  readonly episodeSeed = signal<HandedEpisode | null>(this.handedEpisode());
  readonly expectedKind = signal<MediaType>('movie');

  readonly releases = signal<MovieRelease[]>([]);
  /** Indexers this search queries and where each one is, pushed while it runs. */
  readonly releasesIndexers = signal<IndexerRosterEntry[]>([]);
  readonly releasesLoading = signal(false);
  readonly releasesSearched = signal(false);
  readonly releasesError = signal('');
  readonly releasesEmptyMessage = signal('media_detail.releases_empty');
  readonly grabBusy = signal<string | null>(null);
  readonly grabToast = signal('');
  readonly grabState = signal<Map<string, 'ok' | 'error'>>(new Map());
  /** Movie ids with a grab-best in flight. A set, not a flag: the component
   *  outlives navigation, so a flag would follow the user to the next title. */
  readonly movieGrabBestBusy = signal<ReadonlySet<number>>(new Set());
  /** Only this movie's own grab-best spins; a modal release grab still locks it. */
  readonly movieHeaderGrabBusy = computed(() =>
    this.movieGrabBestBusy().has(this.media()?.id ?? 0) ? 'best' : this.grabBusy(),
  );

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
  readonly selectedProvider = signal<'tmdb' | 'tvdb' | null>(null);
  readonly libraryPatchSaving = signal(false);
  readonly libraryPatchSaved = signal(false);

  readonly canGrab = computed(() => this.auth.hasPermission('media.grab'));
  readonly canManageSubtitles = computed(() => this.auth.hasPermission('subtitles.manage'));
  readonly canEditProfiles = computed(() => this.auth.hasPermission('media.edit'));
  readonly canDelete = computed(() => this.auth.hasPermission('media.delete'));
  readonly isAdmin = computed(() => this.auth.hasPermission('settings.access'));

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
    return ep ? this.watchedEpisodeIds().has(ep.id) : null;
  });

  /** Regular requester (no `media.create` permission). The Demander
   *  actions are only surfaced for them — admins use Grab/Search. */
  readonly canRequest = computed(
    () => !this.auth.hasPermission('media.create') && this.auth.hasPermission('requests.create'),
  );

  /** Requester (no `media.delete`) can ask an admin to delete this library
   *  title. Admins with `media.delete` delete directly and never see it. */
  readonly canRequestDeletion = computed(
    () => this.auth.hasPermission('requests.create') && !this.auth.hasPermission('media.delete'),
  );

  /** A deletion request on this title is already pending (submitted by the
   *  viewer this session or found on load). Hides the deletion entry so a
   *  duplicate can't be attempted. */
  readonly deleteRequestPending = signal(false);

  /** Surfaces the "request deletion" entry: the viewer may request it and no
   *  deletion request is already pending. */
  readonly showRequestDeletion = computed(
    () => this.canRequestDeletion() && !this.deleteRequestPending(),
  );

  /** Global active-request state for the current title (any user). Drives
   *  the Demander gates and the series profile lock. Null until fetched. */
  readonly titleState = signal<TitleRequestState | null>(null);

  /** Whether an active "whole" request already exists on this title (any
   *  user) — a movie request (no seasons concept) or a whole-series request
   *  covering everything. Blocks the Demander entry in the header for the
   *  corresponding case. */
  readonly hasBlockingRequest = computed(() => this.titleState()?.requested ?? false);

  /** Season numbers already covered by an active per-season request (any
   *  user). Gates the season-level Demander entry and pre-fed to the modal. */
  readonly requestedSeasons = computed<number[]>(() => this.titleState()?.requestedSeasons ?? []);
  readonly deleteLoading = signal(false);
  readonly monitoredLoading = signal(false);
  /** Active season tab (series) — first season selected after load */
  readonly activeSeasonId = signal<number | null>(null);
  readonly seasonBusy = signal<number | null>(null);
  readonly seasonWatchedBusy = signal<number | null>(null);
  readonly episodeBusy = signal<number | null>(null);

  readonly episodeDrawerContext = signal<{ season: Season; episode: Episode } | null>(null);

  /** Series: show only episodes with a file on disk (persisted in localStorage) */
  readonly episodesHasFileOnly = signal(readEpisodesHasFileOnlyFromStorage());

  readonly selectedEpisodeId = signal<number | null>(null);
  readonly selectedEpisodeSeasonId = signal<number | null>(null);
  readonly epReleases = signal<MovieRelease[]>([]);
  readonly epReleasesIndexers = signal<IndexerRosterEntry[]>([]);
  readonly epReleasesLoading = signal(false);
  readonly epReleasesSearched = signal(false);
  readonly epReleasesError = signal('');
  readonly epReleasesEmptyMessage = signal('media_detail.releases_empty');
  readonly epGrabBusy = signal<string | null>(null);
  readonly epGrabToast = signal('');
  readonly epGrabState = signal<Map<string, 'ok' | 'error'>>(new Map());
  /** Episode ids with a grab-best in flight — several may run at once. */
  readonly epGrabBestBusy = signal<ReadonlySet<number>>(new Set());
  /** Only the focused episode's own grab-best spins here. */
  readonly epHeaderGrabBusy = computed(() =>
    this.epGrabBestBusy().has(this.focusedEpisode()?.id ?? 0) ? 'best' : this.epGrabBusy(),
  );

  // Season grab
  readonly seasonGrabBusy = signal<string | null>(null);
  readonly seasonReleaseGrabState = signal<Map<string, 'ok' | 'error'>>(new Map());
  /** Season ids with a grab-best in flight — several may run at once. */
  readonly seasonGrabBestBusy = signal<ReadonlySet<number>>(new Set());
  readonly seasonReleasesOpen = signal<number | null>(null);
  readonly seasonForReleases = signal<Season | null>(null);
  readonly seasonReleases = signal<MovieRelease[]>([]);
  readonly seasonReleasesIndexers = signal<IndexerRosterEntry[]>([]);
  readonly seasonReleasesLoading = signal(false);
  readonly seasonReleasesError = signal('');
  readonly seasonReleasesEmptyMessage = signal('media_detail.releases_empty');

  readonly movieReleasesModal = viewChild<ReleasesModalComponent>('movieReleasesModal');
  readonly episodeReleasesModal = viewChild<ReleasesModalComponent>('episodeReleasesModal');
  readonly seasonReleasesModal = viewChild<ReleasesModalComponent>('seasonReleasesModal');
  readonly profilesModal = viewChild(MediaDetailProfilesModalComponent);
  readonly libraryModal = viewChild(MediaDetailLibraryModalComponent);
  readonly subtitleSection = viewChild(SubtitlesModalComponent);

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
    // Admins edit profiles inline; regular requesters need the same
    // options surfaced to fill the request modal. Either permission
    // is enough to justify the round-trip.
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

  /**
   * Paint the episode header from the card's handoff: a stub series carrying
   * the focused episode, replaced wholesale when the real media lands. The
   * stub has no `seasons`, which is what tells the focus effect to leave the
   * seeded episode alone until then.
   */
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
    // Only a back navigation earns the memorized offset. Opening a title from
    // anywhere else — a home card, a similar-movies card that swaps the page
    // under itself — starts at the top, whether or not it was read before.
    const nav =
      this.router.getCurrentNavigation() ?? untracked(this.router.lastSuccessfulNavigation);
    const wentBack = nav?.trigger === 'popstate';
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
    this.watchedEpisodeIds.set(new Set());
    this.episodeProgress.set({});
    this.selectedFileId.set(null);
    this.activeSeasonId.set(null);

    // Card → detail handoff: when the user clicks a media card, we ship what it
    // already knows via router state so the detail page can render immediately
    // instead of on a skeleton. The full fetch below still runs to bring the
    // fields a card doesn't carry (cast/crew/files/seasons).
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
      // Router scroll restoration is 'top' app-wide, so returning here needs the
      // offset put back by hand. Sticky, not a single shot: cast, crew and the
      // hero artwork land after this point, so a one-off scrollTo gets clamped
      // by a document that hasn't reached its full height yet.
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

      // Episode focus (series/:id/episode/:episodeId) is applied reactively
      // by episodeFocusEffect as soon as `media` is set, so no imperative
      // call is needed here.

      // Load cast/crew async — doesn't block page render
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
      // Active requests (only for users who would ever see the Demander
      // button — admins skip the round-trip).
      if (this.canRequest()) {
        void this.loadTitleState(m.tmdbId, m.type);
      }
      if (this.canRequestDeletion()) {
        void this.loadDeleteRequestState(m.tmdbId, m.type);
      }
      void this.loadPlaybackState(m);
    } catch {
      this.notFound.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Re-read what a playback session can have changed under this page, without
   * touching the cast/crew/similar rails the cached DOM still holds.
   */
  private refreshOnReturn(): void {
    const m = this.media();
    if (!m) return;
    void this.loadPlaybackState(m);
    void this.mediaService
      .getOne(m.id, { force: true })
      .then((fresh) => {
        if (fresh.id === m.id) this.media.set(fresh);
      })
      .catch(() => {
        /* network failure — the cached page keeps showing */
      });
  }

  /**
   * Resume position, watched episodes and per-episode progress. These hit the
   * uncacheable /api/playback/media/* routes, so they stay off the render path
   * and are re-run on their own whenever the page comes back on screen.
   */
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
    this.watchedEpisodeIds.set(watchedSet);
    this.episodeProgress.set(progress);

    // Pre-select the last-played file if available
    if (resumeInfo?.mediaFileId) {
      const files = m.files ?? [];
      if (files.some((f) => f.id === resumeInfo.mediaFileId)) {
        this.selectedFileId.set(resumeInfo.mediaFileId);
      }
    }

    // Series: preselect the season the user is currently watching.
    //   1. Latest in-progress episode (resumeInfo).
    //   2. Season of the first unwatched-with-file episode — handles the
    //      between-episodes case (last ep completed, next not started yet)
    //      where resumeInfo is null.
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

  /**
   * Apply the episode-focus state (hero, navbar title) for the current
   * episodeId URL param. Flips `notFound` if the param points at an unknown
   * episode — template then renders the not-found view.
   */
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
      `${m.title} — S${sn}:E${en} — ${foundEpisode.title ?? ''}`,
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

  async loadReleases() {
    const m = this.media();
    if (!m || m.type !== 'movie') return;
    this.releasesLoading.set(true);
    this.releasesError.set('');
    this.releasesEmptyMessage.set('media_detail.releases_empty');
    this.grabToast.set('');
    this.releases.set([]);
    this.releasesIndexers.set([]);
    this.releasesSearched.set(false);
    this.movieReleasesModal()?.showModal();
    try {
      const rows = await this.releaseStream.run(
        (searchId) => this.releasePickerApi.getMovieReleases(m.id, undefined, searchId),
        { releases: this.releases, indexers: this.releasesIndexers },
      );
      this.releases.set(rows);
      this.releasesSearched.set(true);
    } catch (err: unknown) {
      this.releases.set([]);
      this.releasesSearched.set(true);
      if (isUnprofiledReleaseError(err)) {
        this.releasesEmptyMessage.set('media_detail.no_quality_profile');
      } else {
        this.releasesError.set(serverMessage(err, this.translate, 'media_detail.releases_error'));
      }
    } finally {
      this.releasesLoading.set(false);
    }
  }

  /** Runs one grab-best, tracked by target id so a grab on another movie, episode
   *  or season neither spins nor disables this one. Re-entry on the same id is
   *  dropped, which is what stops a double-click grabbing twice. */
  /**
   * Run a grab with the header badge showing its search phase from the click,
   * so the user isn't left with a silent button while the indexers are queried.
   * The badge hands over to the real download as soon as the first progress
   * event lands; on failure the phase clears with the settled request.
   */
  private async withGrabPhase<T>(
    scope: GrabScope,
    run: () => Promise<T>,
  ): Promise<T> {
    const m = this.media();
    const release = m
      ? this.downloadProgress.markGrabbing({ mediaId: m.id, mediaType: m.type, ...scope })
      : () => undefined;
    try {
      const out = await run();
      // Success: the grab is real, so keep the phase up while the download
      // client's first tick makes its way over SSE. Only ever clears a leaf
      // still marked `searching`, so a download that lands sooner is untouched.
      setTimeout(release, GRAB_HANDOFF_MS);
      return out;
    } catch (err) {
      release();
      throw err;
    }
  }

  /** Grab scope for an episode id — the leaf key its download will land under. */
  private episodeScope(episodeId: number): GrabScope {
    for (const s of this.media()?.seasons ?? []) {
      const ep = s.episodes?.find((e) => e.id === episodeId);
      if (ep) return { seasonNumber: s.seasonNumber, episodeNumber: ep.episodeNumber };
    }
    return {};
  }

  private async runGrabBest(
    busy: WritableSignal<ReadonlySet<number>>,
    id: number,
    scope: GrabScope,
    grab: () => Promise<void>,
  ): Promise<void> {
    if (busy().has(id)) return;
    busy.update((s) => new Set(s).add(id));
    try {
      await this.withGrabPhase(scope, grab);
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      /* error toast surfaced by the global interceptor */
    } finally {
      busy.update((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  async grabBest() {
    const m = this.media();
    if (!m || m.type !== 'movie') return;
    await this.runGrabBest(this.movieGrabBestBusy, m.id, {}, () =>
      this.releasePickerApi.grabMovie(m.id, {}),
    );
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
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant('media_detail.confirm_delete', { title: m.title }),
        variant: 'danger',
      }))
    )
      return;
    this.deleteLoading.set(true);
    try {
      await this.mediaService.delete(m.id);
      void this.router.navigate(['/', m.type === 'movie' ? 'movies' : 'series']);
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

  openDownloadModal() {
    const fileId = this.episodeMode() ? this.episodeActiveFileId() : this.activeFileId();
    if (fileId) this.downloadModal()?.open(fileId);
  }

  openDownloadDetailModal() {
    this.downloadDetailModal()?.open();
  }

  openSubtitles() {
    this.subtitleSection()?.show();
  }

  async onDownload(ev: { mediaFileId: number; quality: string }) {
    try {
      const m = this.media();
      const title = m?.title ?? 'Téléchargement';
      const ep = this.focusedEpisode();
      const s = this.focusedSeason();
      let episode: string | undefined;
      if (s && ep) {
        episode = `S${String(s.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`;
        if (ep.title) episode += ` ${ep.title}`;
      }
      await this.downloadManager.createDownload(ev.mediaFileId, ev.quality, title, episode, {
        mediaId: m?.id,
        posterUrl: m?.posterUrl,
        type: m?.type,
        episodeId: ep?.id,
      });
      this.toast.success(this.translate.instant('downloads.started'));
    } catch {
      this.toast.error(this.translate.instant('downloads.error'));
    }
  }

  readonly analyzeRunning = signal(false);
  readonly analyzeOpts = signal<{
    rescan: boolean;
    sprites: boolean;
    crop: boolean;
    subtitleCache: boolean;
    markers: boolean;
  }>({
    rescan: false,
    sprites: false,
    crop: false,
    subtitleCache: false,
    markers: false,
  });

  readonly analyzeHasSelection = computed(() => {
    const o = this.analyzeOpts();
    return o.rescan || o.sprites || o.crop || o.subtitleCache || o.markers;
  });

  /** Intro/outro detection is episode-based, so the analyze option only
   *  applies to series. */
  readonly analyzeShowMarkers = computed(() => this.media()?.type === 'series');

  /** Refs to the native <dialog>. `showModal()` gives us focus trapping,
   *  Tab cycling and Escape-to-close for free — no manual keydown
   *  handling required. */
  private readonly analyzeDialog = viewChild<ElementRef<HTMLDialogElement>>('analyzeDialog');
  private readonly firstAnalyzeOption =
    viewChild<ElementRef<HTMLInputElement>>('firstAnalyzeOption');

  /**
   * Opens one of this page's modals from `?action=`, so a media card can offer
   * the same rows as this menu without every modal being hoisted to the layout:
   * the card navigates here with the action armed and lands on the title being
   * edited. The param is stripped once consumed, or a reload would reopen it.
   */
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
      analyze: () => this.openAnalyzeModal(),
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
  /** The dialog is mounted at the layout now, so it reports through a counter
   *  rather than an output. Ignores the first read: an effect fires once on
   *  creation, which would reload the page on arrival. */
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
    if (m) void this.reloadAfterRescan(m.id);
  }

  openAnalyzeModal() {
    this.analyzeOpts.set({
      rescan: false,
      sprites: false,
      crop: false,
      subtitleCache: false,
      markers: false,
    });
    const dlg = this.analyzeDialog()?.nativeElement;
    if (!dlg) return;
    dlg.showModal();
    // Default focus on the first checkbox so the modal is immediately
    // usable from a keyboard. showModal()'s built-in autofocus would land
    // on the cancel button (last focusable that's also a submit-default).
    queueMicrotask(() => this.firstAnalyzeOption()?.nativeElement.focus());
  }

  closeAnalyzeModal() {
    this.analyzeDialog()?.nativeElement.close();
  }

  setAnalyzeOpt(key: 'rescan' | 'sprites' | 'crop' | 'subtitleCache' | 'markers', value: boolean) {
    this.analyzeOpts.update((o) => ({ ...o, [key]: value }));
  }

  async runAnalyze() {
    const m = this.media();
    if (!m) return;
    const opts = this.analyzeOpts();
    this.analyzeRunning.set(true);
    try {
      // Rescan is the superset — when checked, the granular flags are
      // redundant because rescan re-runs everything. Hit /rescan alone so
      // the existing SSE event stream still fires.
      if (opts.rescan) {
        // Rescan already re-runs intro/outro detection on completion.
        await this.mediaService.rescanFiles(m.id);
      } else {
        if (opts.sprites || opts.crop || opts.subtitleCache) {
          await this.mediaService.analyzeMedia(m.id, {
            sprites: opts.sprites,
            crop: opts.crop,
            subtitleCache: opts.subtitleCache,
          });
        }
        if (opts.markers) {
          await this.markersApi.detectSeries(m.id);
        }
      }
      this.toast.success(this.translate.instant('media_detail.analyze_launched'));
      this.closeAnalyzeModal();
    } catch {
      this.toast.error(this.translate.instant('media_detail.analyze_launch_error'));
    } finally {
      this.analyzeRunning.set(false);
    }
  }

  private async reloadAfterRescan(mediaId: number) {
    try {
      const updated = await this.mediaService.getOne(mediaId);
      this.media.set(updated);
      if (updated.type === 'series') this.syncActiveSeasonForSeriesFilter();
      // Re-resolve focused episode after rescan
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
      void this.loadEpisodeReleases(media.id, c.season.id, c.episode.id);
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

  /** Header releases button: reads the focus signals so the template needs no
   *  season in scope, which it doesn't have until the media lands. */
  loadFocusedEpisodeReleases(): void {
    const m = this.media();
    const s = this.focusedSeason();
    const ep = this.focusedEpisode();
    if (!m || !s || !ep) return;
    void this.loadEpisodeReleases(m.id, s.id, ep.id);
  }

  async loadEpisodeReleases(mediaId: number, seasonId: number, episodeId: number) {
    this.selectedEpisodeId.set(episodeId);
    this.selectedEpisodeSeasonId.set(seasonId);
    this.epReleases.set([]);
    this.epReleasesIndexers.set([]);
    this.epReleasesSearched.set(false);
    this.epReleasesError.set('');
    this.epReleasesEmptyMessage.set('media_detail.releases_empty');
    this.epGrabToast.set('');
    this.epReleasesLoading.set(true);
    this.episodeReleasesModal()?.showModal();
    try {
      const rows = await this.releaseStream.run(
        (searchId) =>
          this.releasePickerApi.getEpisodeReleases(mediaId, episodeId, undefined, searchId),
        { releases: this.epReleases, indexers: this.epReleasesIndexers },
      );
      this.epReleases.set(rows);
      this.epReleasesSearched.set(true);
    } catch (err: unknown) {
      this.epReleasesSearched.set(true);
      if (isUnprofiledReleaseError(err)) {
        this.epReleasesEmptyMessage.set('media_detail.no_quality_profile');
      } else {
        this.epReleasesError.set(serverMessage(err, this.translate, 'media_detail.releases_error'));
      }
    } finally {
      this.epReleasesLoading.set(false);
    }
  }

  async grabEpisodeBest(mediaId: number, episodeId: number) {
    await this.runGrabBest(this.epGrabBestBusy, episodeId, this.episodeScope(episodeId), () =>
      this.releasePickerApi.grabEpisode(mediaId, episodeId, {}),
    );
  }

  async grabEpisodeRelease(mediaId: number, episodeId: number, r: MovieRelease, key: string) {
    this.epGrabBusy.set(key);
    try {
      await this.withGrabPhase(this.episodeScope(episodeId), () =>
        this.releasePickerApi.grabEpisode(mediaId, episodeId, releaseGrabBody(r)),
      );
      this.epGrabState.update((s) => new Map(s).set(key, 'ok'));
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      this.epGrabState.update((s) => new Map(s).set(key, 'error'));
    } finally {
      this.epGrabBusy.set(null);
    }
  }

  async loadSeasonReleases(mediaId: number, season: Season) {
    this.seasonReleasesOpen.set(season.id);
    this.seasonForReleases.set(season);
    this.seasonReleases.set([]);
    this.seasonReleasesIndexers.set([]);
    this.seasonReleasesError.set('');
    this.seasonReleasesEmptyMessage.set('media_detail.releases_empty');
    this.seasonReleasesLoading.set(true);
    this.seasonReleasesModal()?.showModal();
    try {
      const rows = await this.releaseStream.run(
        (searchId) =>
          this.releasePickerApi.getSeasonReleases(mediaId, season.id, undefined, searchId),
        { releases: this.seasonReleases, indexers: this.seasonReleasesIndexers },
      );
      this.seasonReleases.set(rows);
    } catch (err: unknown) {
      if (isUnprofiledReleaseError(err)) {
        this.seasonReleasesEmptyMessage.set('media_detail.no_quality_profile');
      } else {
        this.seasonReleasesError.set(
          serverMessage(err, this.translate, 'media_detail.releases_error'),
        );
      }
    } finally {
      this.seasonReleasesLoading.set(false);
    }
  }

  async grabSeasonAuto(mediaId: number, season: Season) {
    await this.runGrabBest(
      this.seasonGrabBestBusy,
      season.id,
      { seasonNumber: season.seasonNumber },
      () => this.releasePickerApi.grabSeason(mediaId, season.id, {}),
    );
  }

  onGrabSeasonReleaseFromModal(mediaId: number, r: MovieRelease, key: string) {
    const season = this.seasonForReleases();
    if (!season) return;
    void this.grabSeasonRelease(mediaId, season, r, key);
  }

  async grabSeasonRelease(mediaId: number, season: Season, r: MovieRelease, key: string) {
    this.seasonGrabBusy.set(key);
    try {
      await this.withGrabPhase({ seasonNumber: season.seasonNumber }, () =>
        this.releasePickerApi.grabSeason(mediaId, season.id, releaseGrabBody(r)),
      );
      this.seasonReleaseGrabState.update((s) => new Map(s).set(key, 'ok'));
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      this.seasonReleaseGrabState.update((s) => new Map(s).set(key, 'error'));
    } finally {
      this.seasonGrabBusy.set(null);
    }
  }

  async deleteFile(fileId: number, deleteOnDisk: boolean) {
    const m = this.media();
    if (!m) return;
    try {
      await this.mediaService.deleteFile(m.id, fileId, deleteOnDisk);
      this.media.update((media) =>
        media ? { ...media, files: media.files?.filter((f) => f.id !== fileId) } : media,
      );
      this.syncActiveSeasonForSeriesFilter();
    } catch {
      // ignore
    }
  }

  /**
   * Handler for the series root watched toggle. The header has already
   * POSTed to the bulk endpoint (which mirrors the rule "every downloaded
   * episode in a non-special season is watched"); we mirror that same rule
   * locally — no extra round-trip.
   */
  async onToggleSeasonWatched(mediaId: number, season: Season, watched: boolean) {
    if (this.seasonWatchedBusy() === season.id) return;
    this.seasonWatchedBusy.set(season.id);
    try {
      await this.streamingApi.toggleSeasonWatched(mediaId, season.id, watched);
      // Mirror server-side reset locally so progress bars + watched badges
      // refresh without a reload.
      const nextWatched = new Set(this.watchedEpisodeIds());
      const nextProgress = { ...this.episodeProgress() };
      for (const ep of season.episodes ?? []) {
        if (watched) {
          if (ep.hasFile) nextWatched.add(ep.id);
        } else {
          nextWatched.delete(ep.id);
        }
        delete nextProgress[ep.id];
      }
      this.watchedEpisodeIds.set(nextWatched);
      this.episodeProgress.set(nextProgress);
    } catch {
      /* ignore — global error toast handles it */
    } finally {
      this.seasonWatchedBusy.set(null);
    }
  }

  /**
   * Toggle a single episode's watched state from the season panel card.
   * Uses the episode's latest media file for the POST; optimistically updates
   * the local watched set so the badge flips immediately.
   */
  async onToggleEpisodeWatched(mediaId: number, episode: Episode, watched: boolean) {
    const files = filesForEpisode(this.media()?.files, episode.id);
    const fileId = files[0]?.id;
    if (!fileId) return;

    const prev = this.watchedEpisodeIds();
    this.applyEpisodeWatchedLocal(episode.id, watched);

    try {
      await this.streamingApi.toggleWatched(mediaId, fileId, episode.id);
    } catch {
      this.watchedEpisodeIds.set(prev);
    }
  }

  /** Mirror the header's single-episode toggle: it has already called the API,
   *  we just need to refresh local watched/progress state so the surrounding
   *  scroller cards ("Plus de saison X", season panel) reflect the change. */
  onEpisodeWatchedToggledFromHeader(payload: { episodeId: number; watched: boolean }) {
    this.applyEpisodeWatchedLocal(payload.episodeId, payload.watched);
  }

  private applyEpisodeWatchedLocal(episodeId: number, watched: boolean): void {
    const next = new Set(this.watchedEpisodeIds());
    if (watched) next.add(episodeId);
    else next.delete(episodeId);
    this.watchedEpisodeIds.set(next);

    const nextProgress = { ...this.episodeProgress() };
    delete nextProgress[episodeId];
    this.episodeProgress.set(nextProgress);
  }

  onSeriesWatchedToggled(payload: { watched: boolean }) {
    const m = this.media();
    if (!m?.seasons?.length) return;
    // Bulk toggle wipes every episode's positionSeconds server-side — mirror
    // that locally so progress bars on episode cards disappear immediately.
    this.episodeProgress.set({});
    if (!payload.watched) {
      this.watchedEpisodeIds.set(new Set());
      return;
    }
    const ids = new Set<number>();
    for (const s of m.seasons) {
      if (!s.seasonNumber || s.seasonNumber <= 0) continue;
      for (const ep of s.episodes ?? []) {
        if (ep.hasFile) ids.add(ep.id);
      }
    }
    this.watchedEpisodeIds.set(ids);
  }

  async grabRelease(r: MovieRelease, key: string) {
    const m = this.media();
    if (!m || m.type !== 'movie') return;
    this.grabBusy.set(key);
    try {
      await this.withGrabPhase({}, () =>
        this.releasePickerApi.grabMovie(m.id, releaseGrabBody(r)),
      );
      this.grabState.update((s) => new Map(s).set(key, 'ok'));
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      this.grabState.update((s) => new Map(s).set(key, 'error'));
    } finally {
      this.grabBusy.set(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Re-request (user-facing) — surfaced in More dropdowns when the item is
  // missing and the viewer hasn't already requested it. Backend dedups per
  // user across active statuses so the API would refuse a true duplicate;
  // the gating here is purely UX so the action isn't surfaced when pointless.
  // ---------------------------------------------------------------------------

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
  private readonly likesApi = inject(LikesApiService);
  readonly likeState = signal<LikeState>({ media: false, seasonIds: [], episodeIds: [] });
  private lastLikeStateId = 0;
  private readonly likeStateEffect = effect(() => {
    const id = this.media()?.id ?? 0;
    if (id && id !== this.lastLikeStateId) {
      this.lastLikeStateId = id;
      void this.loadLikeState(id);
    }
  });

  private async loadLikeState(id: number): Promise<void> {
    try {
      this.likeState.set(await this.likesApi.state(id, { force: true }));
    } catch {
      /* interceptor surfaces errors */
    }
  }

  /** Like state of the header's current target (movie, or the focused episode). */
  readonly focusedLiked = computed(() => {
    const st = this.likeState();
    if (this.episodeMode()) {
      const ep = this.focusedEpisode();
      return ep ? st.episodeIds.includes(ep.id) : false;
    }
    return st.media;
  });

  seasonLiked(seasonId: number): boolean {
    return this.likeState().seasonIds.includes(seasonId);
  }

  /** Toggle the like on the header target (movie / focused episode). */
  protected async toggleLike(): Promise<void> {
    const m = this.media();
    if (!m) return;
    const ep = this.episodeMode() ? this.focusedEpisode() : null;
    const target = ep ? { mediaId: m.id, episodeId: ep.id } : { mediaId: m.id };
    const wasLiked = this.focusedLiked();
    this.likeState.update((st) =>
      ep
        ? {
            ...st,
            episodeIds: wasLiked
              ? st.episodeIds.filter((i) => i !== ep.id)
              : [...st.episodeIds, ep.id],
          }
        : { ...st, media: !wasLiked },
    );
    try {
      if (wasLiked) await this.likesApi.unlike(target);
      else await this.likesApi.like(target);
    } catch {
      void this.loadLikeState(m.id);
    }
  }

  recommendSeason(seasonId: number): void {
    const m = this.media();
    if (!m) return;
    this.recommend.open({ mediaId: m.id, seasonId });
  }

  async toggleSeasonLike(seasonId: number): Promise<void> {
    const m = this.media();
    if (!m) return;
    const wasLiked = this.seasonLiked(seasonId);
    this.likeState.update((st) => ({
      ...st,
      seasonIds: wasLiked
        ? st.seasonIds.filter((i) => i !== seasonId)
        : [...st.seasonIds, seasonId],
    }));
    try {
      if (wasLiked) await this.likesApi.unlike({ mediaId: m.id, seasonId });
      else await this.likesApi.like({ mediaId: m.id, seasonId });
    } catch {
      void this.loadLikeState(m.id);
    }
  }

  /** Fetch the global active-request state for this title. Run after the
   *  media loads, and again after a successful submit so the gates and the
   *  profile lock flip without a manual reload. */
  private async loadTitleState(tmdbId: number, mediaType: MediaType) {
    try {
      this.titleState.set(await this.requestsApi.getTitleState(tmdbId, mediaType));
    } catch {
      /* swallowed; global interceptor surfaces it */
    }
  }

  /** Seed the pending-deletion gate from the viewer's visible requests so the
   *  entry hides when a deletion request already exists on this title. */
  private async loadDeleteRequestState(tmdbId: number, mediaType: MediaType) {
    try {
      const res = await this.requestsApi.list({ kind: 'delete', status: 'pending' });
      this.deleteRequestPending.set(
        res.data.some((r) => r.tmdbId === tmdbId && r.mediaType === mediaType),
      );
    } catch {
      /* swallowed; the backend still rejects a duplicate on submit */
    }
  }

  /** Ask an admin to delete this library title. Confirms first, then submits a
   *  deletion request scoped to the whole title (movie or series). */
  protected async requestDeletion() {
    const m = this.media();
    if (!m) return;
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('media_detail.request_deletion_title'),
        message: this.translate.instant('media_detail.request_deletion_confirm', {
          title: m.title,
        }),
        variant: 'danger',
      }))
    ) {
      return;
    }
    try {
      await this.requestsApi.create({
        kind: 'delete',
        mediaType: m.type,
        tmdbId: m.tmdbId,
        title: m.title,
      });
      this.deleteRequestPending.set(true);
      this.toast.success(this.translate.instant('media_detail.request_deletion_success'));
    } catch {
      /* error toast surfaced by the global interceptor */
    }
  }

  /** Open the request modal for the current title — movie or
   *  whole-series scope (no seasons pre-selected). */
  protected openRequestForMedia() {
    const m = this.media();
    if (!m) return;
    const state = this.titleState();
    this.requestModal()?.open({
      title: m.title,
      mediaType: m.type,
      tmdbId: m.tmdbId,
      alreadyRequestedSeasons: this.requestedSeasons(),
      profilesLocked: state?.profilesLocked ?? false,
      lockedQualityProfileId: state?.lockedQualityProfileId ?? null,
      lockedLanguageProfileId: state?.lockedLanguageProfileId ?? null,
    });
  }

  /** Open the request modal pre-fed with a single season selected.
   *  Used by the season-level Demander entry. The modal still lets
   *  the user toggle which seasons to send. */
  protected openRequestForSeason(season: Season) {
    const m = this.media();
    if (!m) return;
    const state = this.titleState();
    this.requestModal()?.open({
      title: m.title,
      mediaType: m.type,
      tmdbId: m.tmdbId,
      alreadyRequestedSeasons: this.requestedSeasons(),
      preselectedSeasons: [season.seasonNumber],
      profilesLocked: state?.profilesLocked ?? false,
      lockedQualityProfileId: state?.lockedQualityProfileId ?? null,
      lockedLanguageProfileId: state?.lockedLanguageProfileId ?? null,
    });
  }

  /** Re-fetch on submit so the More-menu Demander disappears and the
   *  season list flips its already-requested badges. */
  protected onRequestSubmitted() {
    const m = this.media();
    if (m) void this.loadTitleState(m.tmdbId, m.type);
  }
}
