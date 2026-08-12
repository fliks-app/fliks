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
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
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
import { MediaDetailReleasePickerService, MovieRelease } from './media-detail-release-picker.service';
import { AuthService } from '../../core/services/auth.service';
import { ProfilesService, LanguageProfile } from '../../core/services/api/profiles.service';
import {
  LibrariesApiService,
  LibrarySummary,
} from '../../core/services/api/libraries-api.service';
import { NavbarService } from '../../core/services/navbar.service';
import { BackgroundService } from '../../core/services/background.service';
import { StreamingApiService, MediaResumeInfo } from '../../core/services/api/streaming-api.service';
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
import {
  TrackingStatusModalComponent,
  TrackingScope,
} from '../../shared/components/tracking-status-modal/tracking-status-modal';
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
import { describeBadge } from '../../shared/utils/download-format';
import { TvService } from '../../core/services/tv.service';
import { DownloadProgressService } from '../../core/services/download-progress.service';
import {
  filesForEpisode,
  filterSeasonEpisodesOnDisk,
  hideShadowedEpisodes,
  seasonsVisibleWithDiskFilter,
} from './media-detail.utils';
import type { MediaFileRow } from './media-detail.utils';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';
import { SseService, type SseEvent } from '../../core/services/sse.service';
import { MediaType } from '../../core/enums/media-type.enum';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { TvSectionDirective } from '../../shared/directives/tv-section.directive';
import { ImgFadeInDirective } from '../../shared/directives/img-fade-in.directive';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';

const LS_EPISODES_HAS_FILE_ONLY = 'fliks.mediaDetail.episodesHasFileOnly';

function readEpisodesHasFileOnlyFromStorage(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(LS_EPISODES_HAS_FILE_ONLY) === '1';
  } catch {
    return false;
  }
}

@Component({
  selector: 'app-media-detail',
  imports: [
    TranslateModule,
    DefaultFocusDirective,
    MediaInfoHeaderComponent,
    MediaInfoExtraComponent,
    SubtitlesModalComponent,
    MediaFileInfoComponent,
    MediaDetailSeasonsComponent,
    ReleasesModalComponent,
    TrackingStatusModalComponent,
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
    ImgFadeInDirective,
    TvSectionDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail.html',
})
export class MediaDetailComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly mediaService = inject(MediaService);
  private readonly releasePickerApi = inject(MediaDetailReleasePickerService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly auth = inject(AuthService);
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

  /** Status badge shown next to the kebab on the movie/series header. Hidden
   *  once the content is downloaded (movie file present / every episode in).
   *  While a download is in flight it shows the mean percent and is clickable
   *  (opens the detail modal); otherwise it reflects the monitored state. */
  readonly headerBadge = computed<MediaInfoHeaderBadge | null>(() => {
    const m = this.media();
    if (!m) return null;
    const downloaded =
      m.type === 'series'
        ? !!m.episodeStats &&
          m.episodeStats.totalEpisodes > 0 &&
          m.episodeStats.downloadedEpisodes >= m.episodeStats.totalEpisodes
        : this.mediaFiles().length > 0;
    const d = describeBadge(this.activeDownload(), {
      monitored: m.monitored,
      downloaded,
    });
    if (!d.labelKey) return null;
    return {
      labelKey: d.labelKey,
      percent: d.percent,
      badgeClass: d.badgeClass,
      // Non-interactive on TV: a focusable in-card/header button would add a
      // second D-pad stop. The download detail is a web/mobile drill-down.
      clickable: d.isClickable && !this.tv.isTv(),
    };
  });
  private readonly downloadModal = viewChild<DownloadQualityModalComponent>('downloadModal');
  private readonly downloadDetailModal =
    viewChild<DownloadDetailModalComponent>('downloadDetailModal');
  /** Same SSE payload must run handlers once; `media` updates (e.g. after rescan) re-run this effect. */
  private lastHandledSseEvent: SseEvent | null = null;

  /**
   * Signal mirror of the route's paramMap. Angular reuses this component when
   * navigating between two `series/:id/episode/:episodeId` URLs, so a plain
   * snapshot read in ngOnInit would miss subsequent param changes.
   */
  private readonly routeParams = toSignal(this.route.paramMap);

  private loadedId: number | null = null;

  /**
   * Angular reuses this component between two `movies/:id` URLs — the similar
   * -movies rail links to one — so the load is driven by the route param
   * instead of ngOnInit, which would only ever run for the first title.
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
    const pool = [m.fanartUrl, ...(m.additionalFanartUrls ?? [])].filter(
      (u): u is string => !!u,
    );
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
      this.toast.success(
        this.translate.instant('media_detail.refresh_ok'),
      );
    } else if (event.type === 'metadata.failed') {
      this.toast.error(
        (event as { error?: string }).error ??
          this.translate.instant('media_detail.refresh_error'),
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
    // legacy data leaked them through.
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
    return this.episodeFiles().find(f => f.id === id) ?? null;
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
    return `S${sn}:${epPart} - ${ep.title ?? ''}`;
  });

  readonly episodeDateLabel = computed(() => {
    const ep = this.focusedEpisode();
    if (!ep?.airDate) return null;
    return new Date(ep.airDate).toLocaleDateString(this.translate.currentLang || undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
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
   * Episodes shown in the "Plus de saison X" row — the focused season minus the
   * episode already open above it: listing the active episode in its own
   * "more from this season" row is redundant.
   */
  readonly moreFromSeasonEpisodes = computed<Episode[]>(() => {
    const activeId = this.focusedEpisode()?.id;
    return this.currentSeasonEpisodes().filter((e) => e.id !== activeId);
  });

  /**
   * Sibling seasons rendered as cards under the "more from season N" row on
   * the episode detail page. Hides the currently-focused season and any
   * empty season (no episodes → no link target).
   */
  readonly otherSeasons = computed<Season[]>(() => {
    const m = this.media();
    const focused = this.focusedSeason();
    if (!m?.seasons || !focused) return [];
    return m.seasons
      .filter((s) => s.id !== focused.id && (s.episodes?.length ?? 0) > 0)
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
   * When the focused episode changes on the episode detail page, bring the
   * "Plus de saison X" scroller to the episode AFTER the active one — the
   * active episode is hidden from the row, so we surface what comes next.
   * When the active episode is the season's last, scroll the row to its end
   * instead. The setTimeout lets the card and its scroll container mount
   * through app-media-detail-seasons → app-horizontal-scroller → ng-content
   * before we measure — they can take a change-detection pass or two to settle.
   */
  private readonly scrollToFocusedEpisodeEffect = effect(() => {
    const active = this.focusedEpisode();
    const eps = this.currentSeasonEpisodes();
    if (
      !active ||
      !this.episodeMode() ||
      this.moreFromSeasonEpisodes().length === 0
    ) {
      return;
    }
    const idx = eps.findIndex((e) => e.id === active.id);
    const next = idx >= 0 ? eps[idx + 1] : undefined;
    setTimeout(() => {
      if (next) this.scrollToEpisode(next.id);
      else this.scrollToEpisodesRowEnd();
    }, 30);
  });

  private scrollToEpisode(epId: number): void {
    const el = document.getElementById(`episode-${epId}`);
    if (!el) return;
    const scroller = this.findHorizontalScrollParent(el);
    if (!scroller) return;
    const elRect = el.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const target =
      scroller.scrollLeft + (elRect.left - scrollerRect.left)
      - scroller.clientWidth / 2 + el.offsetWidth / 2;
    scroller.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }

  /** Scroll the "Plus de saison X" row to its far end — used when the active
   *  episode (hidden from the row) is the season's last, so there is no "next"
   *  card to center on. Anchors off the last rendered card to find the row's
   *  scroller. */
  private scrollToEpisodesRowEnd(): void {
    const last = this.moreFromSeasonEpisodes().at(-1);
    if (!last) return;
    const el = document.getElementById(`episode-${last.id}`);
    if (!el) return;
    const scroller = this.findHorizontalScrollParent(el);
    if (!scroller) return;
    scroller.scrollTo({ left: scroller.scrollWidth, behavior: 'smooth' });
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
          const file = info.mediaFileId
            ? { id: info.mediaFileId }
            : resolveFile(ep.id);
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

  readonly nextPlayEpisodeId = computed(
    () => this.nextPlayEpisode()?.episode.id,
  );
  readonly nextPlayMediaFileId = computed(
    () => this.nextPlayEpisode()?.file.id,
  );

  /** Directors for shared header */
  readonly directors = computed(() =>
    this.crew()
      .filter(c => c.job?.toLowerCase() === 'director')
      .map(c => c.person.name),
  );

  readonly loading = signal(true);
  readonly notFound = signal(false);
  readonly expectedKind = signal<MediaType>('movie');

  readonly releases = signal<MovieRelease[]>([]);
  readonly releasesLoading = signal(false);
  readonly releasesSearched = signal(false);
  readonly releasesError = signal('');
  readonly grabBusy = signal<string | null>(null);
  readonly grabToast = signal('');
  readonly grabState = signal<Map<string, 'ok' | 'error'>>(new Map());

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

  /** Regular requester (no `media.create` permission). The Demander
   *  actions are only surfaced for them — admins use Grab/Search. */
  readonly canRequest = computed(
    () =>
      !this.auth.hasPermission('media.create') &&
      this.auth.hasPermission('requests.create'),
  );

  /** Requester (no `media.delete`) can ask an admin to delete this library
   *  title. Admins with `media.delete` delete directly and never see it. */
  readonly canRequestDeletion = computed(
    () =>
      this.auth.hasPermission('requests.create') &&
      !this.auth.hasPermission('media.delete'),
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
  readonly hasBlockingRequest = computed(
    () => this.titleState()?.requested ?? false,
  );

  /** Season numbers already covered by an active per-season request (any
   *  user). Gates the season-level Demander entry and pre-fed to the modal. */
  readonly requestedSeasons = computed<number[]>(
    () => this.titleState()?.requestedSeasons ?? [],
  );
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
  readonly epReleasesLoading = signal(false);
  readonly epReleasesSearched = signal(false);
  readonly epReleasesError = signal('');
  readonly epGrabBusy = signal<string | null>(null);
  readonly epGrabToast = signal('');
  readonly epGrabState = signal<Map<string, 'ok' | 'error'>>(new Map());

  // Season grab
  readonly seasonGrabBusy = signal<string | null>(null);
  readonly seasonReleaseGrabState = signal<Map<string, 'ok' | 'error'>>(new Map());
  readonly seasonReleasesOpen = signal<number | null>(null);
  readonly seasonForReleases = signal<Season | null>(null);
  readonly seasonReleases = signal<MovieRelease[]>([]);
  readonly seasonReleasesLoading = signal(false);
  readonly seasonReleasesError = signal('');

  readonly movieReleasesModal = viewChild<ReleasesModalComponent>('movieReleasesModal');
  readonly episodeReleasesModal = viewChild<ReleasesModalComponent>('episodeReleasesModal');
  readonly seasonReleasesModal = viewChild<ReleasesModalComponent>('seasonReleasesModal');
  readonly profilesModal = viewChild(MediaDetailProfilesModalComponent);
  readonly libraryModal = viewChild(MediaDetailLibraryModalComponent);
  readonly subtitleSection = viewChild(SubtitlesModalComponent);
  readonly trackingModal = viewChild(TrackingStatusModalComponent);

  openTracking(scope: TrackingScope): void {
    const id = this.media()?.id;
    if (id == null) return;
    void this.trackingModal()?.open(id, scope);
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
    this.scrollMemory.deactivate();
    this.navbarService.leaveHeroPage();
    this.backgroundService.clear();
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
    if (
      !this.auth.hasPermission('media.edit') &&
      !this.auth.hasPermission('requests.create')
    ) return;
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

  private async loadMedia(id: number) {
    const kind = this.route.snapshot.data['kind'] as MediaType;
    // Only a back navigation earns the memorized offset. Opening a title from
    // anywhere else — a home card, a similar-movies card that swaps the page
    // under itself — starts at the top, whether or not it was read before.
    const nav =
      this.router.getCurrentNavigation() ??
      untracked(this.router.lastSuccessfulNavigation);
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

    // Card → detail handoff: when the user clicks a media card, we ship the
    // already-loaded Media via router state so the detail page can render
    // immediately with the same poster/title/year. The full fetch below still
    // runs in the background to refresh fields the card doesn't carry
    // (cast/crew/files/seasons). Spinner only stays for cold deep-links.
    const passed = (history.state as { media?: Media })?.media;
    if (passed && passed.id === id && passed.type === kind) {
      this.media.set(passed);
      this.loading.set(false);
    } else if (this.media()?.id !== id) {
      this.media.set(null);
      this.loading.set(true);
    }

    try {
      const m = await this.mediaService.getOne(id);
      if (m.type !== kind) {
        void this.router.navigate([
          '/',
          m.type === 'movie' ? 'movies' : 'series',
          m.id,
        ]);
        return;
      }
      this.media.set(m);
      // Paint from the cache-served media immediately; the uncacheable
      // playback-state calls below must not gate first paint.
      this.loading.set(false);
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
          .catch(() => { /* network failure — cached body keeps showing */ });
      });

      // Episode focus (series/:id/episode/:episodeId) is applied reactively
      // by episodeFocusEffect as soon as `media` is set, so no imperative
      // call is needed here.

      // Load cast/crew async — doesn't block page render
      this.mediaService.getCast(m.id).then((c) => this.cast.set(c)).catch(() => {});
      this.mediaService.getCrew(m.id).then((c) => this.crew.set(c)).catch(() => {});
      if (m.type === 'movie') {
        this.mediaService.getSimilar(m.id).then((s) => this.similar.set(s)).catch(() => {});
        this.mediaService.getCollection(m.id).then((c) => this.collection.set(c)).catch(() => {});
      }
      // Active requests (only for users who would ever see the Demander
      // button — admins skip the round-trip).
      if (this.canRequest()) {
        void this.loadTitleState(m.tmdbId, m.type);
      }
      if (this.canRequestDeletion()) {
        void this.loadDeleteRequestState(m.tmdbId, m.type);
      }
      // Resume/watched/progress hit uncacheable /api/playback/media/* — load
      // them off the render path so a slow server never holds the spinner.
      void (async () => {
        const [resumeInfo, watchedIds, progress] = await Promise.all([
          this.streamingApi.getMediaResumeInfo(m.id).catch(() => null),
          m.type === 'series'
            ? this.streamingApi.getWatchedEpisodeIds(m.id).catch(() => [] as number[])
            : Promise.resolve([] as number[]),
          m.type === 'series'
            ? this.streamingApi
                .getEpisodeProgress(m.id)
                .catch(() => ({}) as Record<number, number>)
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
              m.seasons.find((s) =>
                s.episodes?.some((e) => e.id === resumeInfo.episodeId),
              )?.id ?? null;
          }
          if (targetSeasonId == null) {
            targetSeasonId =
              m.seasons.find((s) =>
                s.episodes?.some(
                  (e) => e.hasFile && !watchedSet.has(e.id),
                ),
              )?.id ?? null;
          }
          if (targetSeasonId != null) {
            this.activeSeasonId.set(targetSeasonId);
            this.persistActiveSeason(targetSeasonId);
            resumeHandled = true;
          }
        }

        if (m.type === 'series' && m.seasons?.length) {
          if (!resumeHandled) this.syncActiveSeasonForSeriesFilter();
          // Scroll to first unwatched episode in active season
          const seasonId = this.activeSeasonId();
          const activeSeason = m.seasons.find((s) => s.id === seasonId);
          if (activeSeason?.episodes?.length) {
            const firstUnwatched = activeSeason.episodes.find((e) => e.hasFile && !watchedSet.has(e.id));
            if (firstUnwatched) {
              requestAnimationFrame(() => {
                const el = document.getElementById(`episode-${firstUnwatched.id}`);
                if (!el) return;
                const scroller = el.parentElement;
                if (scroller && scroller.scrollWidth > scroller.clientWidth) {
                  const elRect = el.getBoundingClientRect();
                  const scrollerRect = scroller.getBoundingClientRect();
                  const offset = elRect.left - scrollerRect.left + scroller.scrollLeft - scroller.clientWidth / 2 + el.offsetWidth / 2;
                  scroller.scrollTo({ left: offset, behavior: 'smooth' });
                }
              });
            }
          }
        } else {
          this.activeSeasonId.set(null);
        }
      })();
    } catch {
      this.notFound.set(true);
    } finally {
      this.loading.set(false);
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
      let updated =
        libId !== m.libraryId
          ? await this.mediaService.patchLibrary(m.id, libId)
          : m;
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
      const httpErr = err as { error?: { message?: string } };
      this.profilesErr.set(
        httpErr.error?.message ??
          this.translate.instant('media_detail.profiles_save_error'),
      );
    } finally {
      this.profilesSaveLoading.set(false);
    }
  }

  async loadReleases() {
    const m = this.media();
    if (!m || m.type !== 'movie') return;
    this.releasesLoading.set(true);
    this.releasesError.set('');
    this.grabToast.set('');
    this.releases.set([]);
    this.releasesSearched.set(false);
    this.movieReleasesModal()?.showModal();
    try {
      const rows = await this.releasePickerApi.getMovieReleases(m.id);
      this.releases.set(rows);
      this.releasesSearched.set(true);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.releases.set([]);
      this.releasesSearched.set(true);
      this.releasesError.set(
        httpErr.error?.message ??
          this.translate.instant('media_detail.releases_error'),
      );
    } finally {
      this.releasesLoading.set(false);
    }
  }

  async grabBest() {
    const m = this.media();
    if (!m || m.type !== 'movie') return;
    this.grabBusy.set('best');
    try {
      await this.releasePickerApi.grabMovie(m.id, {});
      this.grabState.update((s) => new Map(s).set('best', 'ok'));
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      this.grabState.update((s) => new Map(s).set('best', 'error'));
    } finally {
      this.grabBusy.set(null);
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
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('media_detail.confirm_delete', { title: m.title }), variant: 'danger' })) return;
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
      this.toast.success(
        this.translate.instant('media_detail.refresh_launched'),
      );
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.toast.error(
        httpErr.error?.message ??
          this.translate.instant('media_detail.refresh_error'),
      );
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
        mediaId: m?.id, posterUrl: m?.posterUrl, type: m?.type, episodeId: ep?.id,
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
  readonly analyzeShowMarkers = computed(
    () => this.media()?.type === 'series',
  );

  /** Refs to the native <dialog>. `showModal()` gives us focus trapping,
   *  Tab cycling and Escape-to-close for free — no manual keydown
   *  handling required. */
  private readonly analyzeDialog =
    viewChild<ElementRef<HTMLDialogElement>>('analyzeDialog');
  private readonly firstAnalyzeOption =
    viewChild<ElementRef<HTMLInputElement>>('firstAnalyzeOption');

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

  setAnalyzeOpt(
    key: 'rescan' | 'sprites' | 'crop' | 'subtitleCache' | 'markers',
    value: boolean,
  ) {
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
      this.toast.success(
        this.translate.instant('media_detail.analyze_launched'),
      );
      this.closeAnalyzeModal();
    } catch {
      this.toast.error(
        this.translate.instant('media_detail.analyze_launch_error'),
      );
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
          const fresh = s.episodes?.find(e => e.id === ep.id);
          if (fresh) { this.focusedSeason.set(s); this.focusedEpisode.set(fresh); break; }
        }
      }
    } catch { /* ignore */ }
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
    } catch { /* private mode */ }
  }

  private restoreActiveSeason(): number | null {
    const m = this.media();
    if (!m) return null;
    try {
      const v = sessionStorage.getItem(`fliks.season.${m.id}`);
      return v ? Number(v) : null;
    } catch { return null; }
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
      const updated = await this.mediaService.updateEpisodeMonitored(episode.id, !episode.monitored);
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

  async loadEpisodeReleases(mediaId: number, seasonId: number, episodeId: number) {
    this.selectedEpisodeId.set(episodeId);
    this.selectedEpisodeSeasonId.set(seasonId);
    this.epReleases.set([]);
    this.epReleasesSearched.set(false);
    this.epReleasesError.set('');
    this.epGrabToast.set('');
    this.epReleasesLoading.set(true);
    this.episodeReleasesModal()?.showModal();
    try {
      const rows = await this.releasePickerApi.getEpisodeReleases(mediaId, episodeId);
      this.epReleases.set(rows);
      this.epReleasesSearched.set(true);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.epReleasesSearched.set(true);
      this.epReleasesError.set(
        httpErr.error?.message ?? this.translate.instant('media_detail.releases_error'),
      );
    } finally {
      this.epReleasesLoading.set(false);
    }
  }

  async grabEpisodeBest(mediaId: number, episodeId: number) {
    this.epGrabBusy.set('best');
    try {
      await this.releasePickerApi.grabEpisode(mediaId, episodeId, {});
      this.epGrabState.update((s) => new Map(s).set('best', 'ok'));
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      this.epGrabState.update((s) => new Map(s).set('best', 'error'));
    } finally {
      this.epGrabBusy.set(null);
    }
  }

  async grabEpisodeRelease(mediaId: number, episodeId: number, r: MovieRelease, index: number) {
    const key = `ep-${index}`;
    this.epGrabBusy.set(key);
    try {
      await this.releasePickerApi.grabEpisode(mediaId, episodeId, {
        downloadUrl: r.downloadUrl,
        sourceTitle: r.title,
        sourceId: r.sourceId,
      });
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
    this.seasonReleasesError.set('');
    this.seasonReleasesLoading.set(true);
    this.seasonReleasesModal()?.showModal();
    try {
      const rows = await this.releasePickerApi.getSeasonReleases(mediaId, season.id);
      this.seasonReleases.set(rows);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.seasonReleasesError.set(
        httpErr.error?.message ?? this.translate.instant('media_detail.releases_error'),
      );
    } finally {
      this.seasonReleasesLoading.set(false);
    }
  }

  async grabSeasonAuto(mediaId: number, season: Season) {
    this.seasonGrabBusy.set('best');
    try {
      await this.releasePickerApi.grabSeason(mediaId, season.id, {});
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      /* error toast surfaced by the global interceptor */
    } finally {
      this.seasonGrabBusy.set(null);
    }
  }

  onGrabSeasonReleaseFromModal(mediaId: number, r: MovieRelease, index: number) {
    const season = this.seasonForReleases();
    if (!season) return;
    void this.grabSeasonRelease(mediaId, season, r, index);
  }

  async grabSeasonRelease(mediaId: number, season: Season, r: MovieRelease, index: number) {
    const key = `s-${index}`;
    this.seasonGrabBusy.set(key);
    try {
      await this.releasePickerApi.grabSeason(mediaId, season.id, {
        downloadUrl: r.downloadUrl,
        sourceTitle: r.title,
        sourceId: r.sourceId,
      });
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

  async grabRelease(r: MovieRelease, index: number) {
    const m = this.media();
    if (!m || m.type !== 'movie') return;
    const key = `r-${index}`;
    this.grabBusy.set(key);
    try {
      await this.releasePickerApi.grabMovie(m.id, {
        downloadUrl: r.downloadUrl,
        sourceTitle: r.title,
        sourceId: r.sourceId,
      });
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
      this.titleState.set(
        await this.requestsApi.getTitleState(tmdbId, mediaType),
      );
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
      this.toast.success(
        this.translate.instant('media_detail.request_deletion_success'),
      );
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
