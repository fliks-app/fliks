import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  computed,
  effect,
  OnInit,
  OnDestroy,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  MediaService,
  Media,
  Season,
  Episode,
  MovieRelease,
  MediaCastEntry,
  MediaCrewEntry,
} from '../../core/services/api/media.service';
import { AuthService } from '../../core/services/auth.service';
import { ProfilesService, LanguageProfile } from '../../core/services/api/profiles.service';
import {
  LibrariesApiService,
  Library,
} from '../../core/services/api/libraries-api.service';
import { NavbarService } from '../../core/services/navbar.service';
import { StreamingApiService, MediaResumeInfo } from '../../core/services/api/streaming-api.service';
import { MediaInfoHeaderComponent } from '../../shared/components/media-info-header/media-info-header';
import { SubtitleSectionComponent } from '../../shared/components/subtitle-section/subtitle-section';
import { MediaFileInfoComponent } from '../../shared/components/media-file-info';
import { MediaDetailSeasonsComponent } from './components/media-detail-seasons/media-detail-seasons.component';
import { ReleasesModalComponent } from './components/releases-modal/releases-modal.component';
import { MediaDetailProfilesModalComponent } from './components/media-detail-profiles-modal/media-detail-profiles-modal.component';
import { MediaDetailRootFolderModalComponent } from './components/media-detail-root-folder-modal/media-detail-root-folder-modal.component';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { DownloadQualityModalComponent } from '../../shared/components/download-quality-modal/download-quality-modal';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import {
  filesForEpisode,
  filterSeasonEpisodesOnDisk,
  seasonsVisibleWithDiskFilter,
} from './media-detail.utils';
import type { MediaFileRow } from './media-detail.utils';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';
import { SseService, type SseEvent } from '../../core/services/sse.service';
import { MediaType } from '../../core/enums/media-type.enum';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';

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
    MediaInfoHeaderComponent,
    SubtitleSectionComponent,
    MediaFileInfoComponent,
    MediaDetailSeasonsComponent,
    ReleasesModalComponent,
    MediaDetailProfilesModalComponent,
    MediaDetailRootFolderModalComponent,
    HorizontalScrollerComponent,
    DownloadQualityModalComponent,
    RouterLink,
    NgTemplateOutlet,
    ResolveUrlPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail.html',
})
export class MediaDetailComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly mediaService = inject(MediaService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly navbarService = inject(NavbarService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly sse = inject(SseService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly downloadManager = inject(DownloadManagerService);
  private readonly downloadModal = viewChild<DownloadQualityModalComponent>('downloadModal');
  /** Same SSE payload must run handlers once; `media` updates (e.g. after rescan) re-run this effect. */
  private lastHandledSseEvent: SseEvent | null = null;

  /** React to SSE rescan events for this media */
  private readonly sseEffect = effect(() => {
    const event = this.sse.lastEvent();
    const m = this.media();
    if (!event || !m) return;
    if ((event['mediaId'] as number) !== m.id) return;
    if (event === this.lastHandledSseEvent) return;
    this.lastHandledSseEvent = event;
    if (event.type === 'rescan.completed') {
      void this.reloadAfterRescan(m.id);
    }
  });

  readonly media = signal<Media | null>(null);
  readonly cast = signal<MediaCastEntry[]>([]);
  readonly crew = signal<MediaCrewEntry[]>([]);
  readonly resumeInfo = signal<MediaResumeInfo | null>(null);
  readonly watchedEpisodeIds = signal<Set<number>>(new Set());
  readonly mediaFiles = computed(() => {
    const m = this.media();
    if (!m) return [];
    const list = m.files ?? [];
    return m.type === 'series' ? list.filter((f) => !f.episodeId) : list;
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

  readonly episodeActiveFileId = computed(() =>
    this.selectedFileId() ?? this.episodeFiles()[0]?.id ?? null,
  );

  readonly episodeActiveFile = computed(() => {
    const id = this.episodeActiveFileId();
    return this.episodeFiles().find(f => f.id === id) ?? null;
  });

  readonly episodeLabel = computed(() => {
    const ep = this.focusedEpisode();
    const s = this.focusedSeason();
    if (!ep || !s) return null;
    return `S${String(s.seasonNumber).padStart(2, '0')}:E${String(ep.episodeNumber).padStart(2, '0')} - ${ep.title ?? ''}`;
  });

  readonly episodeDateLabel = computed(() => {
    const ep = this.focusedEpisode();
    if (!ep?.airDate) return null;
    return new Date(ep.airDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  });

  readonly episodeSeriesRoute = computed(() => {
    const m = this.media();
    return m ? ['/series', String(m.id)] : ['/series'];
  });

  /** Resume episode label for series header (e.g. "S01:E03 - Title") */
  readonly resumeEpisodeLabel = computed(() => {
    const info = this.resumeInfo();
    const m = this.media();
    if (!info?.episodeId || !m?.seasons) return null;
    for (const s of m.seasons) {
      const ep = s.episodes?.find(e => e.id === info.episodeId);
      if (ep) {
        const sn = String(s.seasonNumber).padStart(2, '0');
        const en = String(ep.episodeNumber).padStart(2, '0');
        return `S${sn}:E${en} - ${ep.title ?? ''}`;
      }
    }
    return null;
  });

  /** Directors for shared header */
  readonly directors = computed(() =>
    this.crew()
      .filter(c => c.job?.toLowerCase() === 'director')
      .map(c => c.person.name),
  );

  readonly loading = signal(true);
  readonly notFound = signal(false);
  readonly expectedKind = signal<MediaType>('movie');

  readonly customSearchQuery = signal('');

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

  readonly libraries = signal<Library[]>([]);
  readonly selectedLibraryId = signal<number | null>(null);
  readonly pathSaving = signal(false);
  readonly pathOk = signal(false);

  readonly canGrab = computed(() => this.auth.hasPermission('media.grab'));
  readonly canEditProfiles = computed(() => this.auth.hasPermission('media.edit'));
  readonly isAdmin = computed(() => this.auth.hasPermission('settings.access'));
  readonly deleteLoading = signal(false);
  readonly renameLoading = signal(false);
  readonly renameToast = signal('');
  readonly monitoredLoading = signal(false);
  readonly refreshLoading = signal(false);
  readonly refreshToast = signal('');
  /** Active season tab (series) — first season selected after load */
  readonly activeSeasonId = signal<number | null>(null);
  readonly seasonBusy = signal<number | null>(null);
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
  readonly rootFolderModal = viewChild(MediaDetailRootFolderModalComponent);
  readonly subtitleSection = viewChild(SubtitleSectionComponent);

  readonly episodeDialogFiles = computed(() => {
    const c = this.episodeDrawerContext();
    const m = this.media();
    if (!c || !m?.files) return [];
    return filesForEpisode(m.files, c.episode.id);
  });

  ngOnDestroy() {
    this.navbarService.leaveHeroPage();
  }

  async ngOnInit() {
    // Enter hero page immediately (transparent navbar) — title will be set after media loads
    this.navbarService.enterHeroPage('');
    const kind = this.route.snapshot.data['kind'] as MediaType;
    this.expectedKind.set(kind);
    const idParam = this.route.snapshot.paramMap.get('id');
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isFinite(id) || id < 1) {
      this.loading.set(false);
      this.notFound.set(true);
      return;
    }

    const loadProfiles = async () => {
      if (!this.auth.hasPermission('media.edit')) return;
      this.profilesOptionsLoading.set(true);
      try {
        const [q, l, libs] = await Promise.all([
          this.profilesApi.getQualityProfiles(),
          this.profilesApi.getLanguageProfiles(),
          this.librariesApi.list(),
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
    };

    // Load profiles in parallel with media — neither blocks the other
    void loadProfiles();

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

      // Episode mode: series/:id/episode/:episodeId
      const episodeIdParam = this.route.snapshot.paramMap.get('episodeId');
      if (episodeIdParam) {
        const episodeId = Number(episodeIdParam);
        let foundSeason: Season | null = null;
        let foundEpisode: Episode | null = null;
        for (const s of m.seasons ?? []) {
          const ep = s.episodes?.find(e => e.id === episodeId);
          if (ep) { foundSeason = s; foundEpisode = ep; break; }
        }
        if (!foundEpisode) {
          this.notFound.set(true);
          this.loading.set(false);
          return;
        }
        this.episodeMode.set(true);
        this.focusedSeason.set(foundSeason);
        this.focusedEpisode.set(foundEpisode);
        const sn = String(foundSeason!.seasonNumber).padStart(2, '0');
        const en = String(foundEpisode.episodeNumber).padStart(2, '0');
        this.navbarService.enterHeroPage(`${m.title} — S${sn}:E${en} — ${foundEpisode.title ?? ''}`);
      } else {
        this.navbarService.enterHeroPage(m.title);
      }

      // Load cast/crew async — doesn't block page render
      this.mediaService.getCast(m.id).then((c) => this.cast.set(c)).catch(() => {});
      this.mediaService.getCrew(m.id).then((c) => this.crew.set(c)).catch(() => {});
      // Load resume + watched episodes for series
      const [resumeInfo, watchedIds] = await Promise.all([
        this.streamingApi.getMediaResumeInfo(m.id).catch(() => null),
        m.type === 'series'
          ? this.streamingApi.getWatchedEpisodeIds(m.id).catch(() => [] as number[])
          : Promise.resolve([] as number[]),
      ]);
      this.resumeInfo.set(resumeInfo);
      const watchedSet = new Set(watchedIds);
      this.watchedEpisodeIds.set(watchedSet);

      // Pre-select the last-played file if available
      if (resumeInfo?.mediaFileId) {
        const files = m.files ?? [];
        if (files.some((f) => f.id === resumeInfo.mediaFileId)) {
          this.selectedFileId.set(resumeInfo.mediaFileId);
        }
      }

      // Series: select season from resume, then scroll to first unwatched
      let resumeHandled = false;
      if (m.type === 'series' && resumeInfo?.episodeId && m.seasons?.length) {
        for (const s of m.seasons) {
          if (s.episodes?.some((e) => e.id === resumeInfo.episodeId)) {
            this.activeSeasonId.set(s.id);
            this.persistActiveSeason(s.id);
            resumeHandled = true;
            break;
          }
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
      this.draftQualityProfileId.set(m.qualityProfile?.id ?? null);
      this.draftLanguageProfileId.set(m.languageProfile?.id ?? null);
      this.selectedLibraryId.set(m.libraryId ?? null);
    } catch {
      this.notFound.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  backSegment(): string {
    return this.expectedKind() === 'movie' ? 'movies' : 'series';
  }

  openRootFolderModal() {
    this.pathOk.set(false);
    this.rootFolderModal()?.showModal();
  }

  async saveRootFolder() {
    const m = this.media();
    if (!m) return;
    const libId = this.selectedLibraryId();
    if (libId == null) return;
    this.pathSaving.set(true);
    this.pathOk.set(false);
    try {
      const updated = await this.mediaService.patchLibrary(m.id, libId);
      this.media.set(updated);
      if (updated.type === 'series') this.syncActiveSeasonForSeriesFilter();
      this.pathOk.set(true);
      setTimeout(() => this.pathOk.set(false), 3000);
    } finally {
      this.pathSaving.set(false);
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
      const rows = await this.mediaService.getMovieReleases(m.id, this.customSearchQuery());
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
      await this.mediaService.grabMovie(m.id, {});
      this.grabState.update((s) => new Map(s).set('best', 'ok'));
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      this.grabState.update((s) => new Map(s).set('best', 'error'));
      this.toast.error(this.translate.instant('media_detail.grab_error'));
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
      if (updated.type === 'series') this.syncActiveSeasonForSeriesFilter();
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
    this.refreshLoading.set(true);
    this.refreshToast.set('');
    try {
      const ep = this.focusedEpisode();
      const updated = ep
        ? await this.mediaService.refreshEpisodeMetadata(m.id, ep.id)
        : await this.mediaService.refreshMetadata(m.id);
      this.media.set(updated);
      if (updated.type === 'series') this.syncActiveSeasonForSeriesFilter();
      // Re-resolve focused episode
      if (ep) {
        for (const s of updated.seasons ?? []) {
          const fresh = s.episodes?.find(e => e.id === ep.id);
          if (fresh) { this.focusedSeason.set(s); this.focusedEpisode.set(fresh); break; }
        }
      }
      this.refreshToast.set(this.translate.instant('media_detail.refresh_ok'));
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.refreshToast.set(
        httpErr.error?.message ?? this.translate.instant('media_detail.refresh_error'),
      );
    } finally {
      this.refreshLoading.set(false);
    }
  }

  openDownloadModal() {
    const fileId = this.episodeMode() ? this.episodeActiveFileId() : this.activeFileId();
    if (fileId) this.downloadModal()?.open(fileId);
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
      await this.downloadManager.createDownload(ev.mediaFileId, ev.quality, title, episode);
      this.toast.success(this.translate.instant('downloads.started'));
    } catch {
      this.toast.error(this.translate.instant('downloads.error'));
    }
  }

  async rescanFiles() {
    const m = this.media();
    if (!m) return;
    try {
      await this.mediaService.rescanFiles(m.id);
      this.toast.success(
        this.translate.instant('media_detail.rescan_launched'),
      );
    } catch {
      this.toast.error(
        this.translate.instant('media_detail.rescan_launch_error'),
      );
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
    return filterSeasonEpisodesOnDisk(season, m, this.episodesHasFileOnly());
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
      this.media.set({
        ...m,
        seasons: m.seasons.map((s) =>
          s.id === updated.id ? { ...s, monitored: updated.monitored } : s,
        ),
      });
      this.syncActiveSeasonForSeriesFilter();
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
      const rows = await this.mediaService.getEpisodeReleases(mediaId, episodeId, this.customSearchQuery());
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
      await this.mediaService.grabEpisode(mediaId, episodeId, {});
      this.epGrabState.update((s) => new Map(s).set('best', 'ok'));
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      this.epGrabState.update((s) => new Map(s).set('best', 'error'));
      this.toast.error(this.translate.instant('media_detail.grab_error'));
    } finally {
      this.epGrabBusy.set(null);
    }
  }

  async grabEpisodeRelease(mediaId: number, episodeId: number, r: MovieRelease, index: number) {
    const key = `ep-${index}`;
    this.epGrabBusy.set(key);
    try {
      await this.mediaService.grabEpisode(mediaId, episodeId, { downloadUrl: r.downloadUrl, sourceTitle: r.title });
      this.epGrabState.update((s) => new Map(s).set(key, 'ok'));
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      this.epGrabState.update((s) => new Map(s).set(key, 'error'));
      this.toast.error(this.translate.instant('media_detail.grab_error'));
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
      const rows = await this.mediaService.getSeasonReleases(mediaId, season.id, this.customSearchQuery());
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
      await this.mediaService.grabSeason(mediaId, season.id, {});
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      this.toast.error(this.translate.instant('media_detail.grab_error'));
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
      await this.mediaService.grabSeason(mediaId, season.id, {
        downloadUrl: r.downloadUrl,
        sourceTitle: r.title,
      });
      this.seasonReleaseGrabState.update((s) => new Map(s).set(key, 'ok'));
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      this.seasonReleaseGrabState.update((s) => new Map(s).set(key, 'error'));
      this.toast.error(this.translate.instant('media_detail.grab_error'));
    } finally {
      this.seasonGrabBusy.set(null);
    }
  }

  async renameFiles() {
    const m = this.media();
    if (!m) return;
    this.renameLoading.set(true);
    this.renameToast.set('');
    try {
      const result = await this.mediaService.renameFiles(m.id);
      this.renameToast.set(this.translate.instant('media_detail.rename_ok', { count: result.renamed }));
      const updated = await this.mediaService.getOne(m.id);
      this.media.set(updated);
      if (updated.type === 'series') this.syncActiveSeasonForSeriesFilter();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.renameToast.set(httpErr.error?.message ?? this.translate.instant('media_detail.rename_error'));
    } finally {
      this.renameLoading.set(false);
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
  onSeriesWatchedToggled(payload: { watched: boolean }) {
    const m = this.media();
    if (!m?.seasons?.length) return;
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
      await this.mediaService.grabMovie(m.id, { downloadUrl: r.downloadUrl, sourceTitle: r.title });
      this.grabState.update((s) => new Map(s).set(key, 'ok'));
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      this.grabState.update((s) => new Map(s).set(key, 'error'));
      this.toast.error(this.translate.instant('media_detail.grab_error'));
    } finally {
      this.grabBusy.set(null);
    }
  }
}
