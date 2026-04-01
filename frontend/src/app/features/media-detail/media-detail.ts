import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  computed,
  OnInit,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  MediaService,
  Media,
  Season,
  Episode,
  MovieRelease,
} from '../../core/services/api/media.service';
import { AuthService } from '../../core/services/auth.service';
import { ProfilesService, LanguageProfile } from '../../core/services/api/profiles.service';
import {
  RootFoldersApiService,
  RootFolder,
} from '../../core/services/api/root-folders-api.service';
import {
  SubtitlesApiService,
  SubtitleFileRow,
  SubtitleSearchResult,
} from '../../core/services/api/subtitles-api.service';
import { MediaDetailHeaderComponent } from './components/media-detail-header/media-detail-header.component';
import { MediaDetailFilesComponent } from './components/media-detail-files/media-detail-files.component';
import { MediaDetailSubtitlesComponent } from './components/media-detail-subtitles/media-detail-subtitles.component';
import { MediaDetailSeasonsComponent } from './components/media-detail-seasons/media-detail-seasons.component';
import { MediaDetailMovieDownloadComponent } from './components/media-detail-movie-download/media-detail-movie-download.component';
import { MediaDetailSubtitleSearchModalComponent } from './components/media-detail-subtitle-search-modal/media-detail-subtitle-search-modal.component';
import { ReleasesModalComponent } from './components/releases-modal/releases-modal.component';
import { MediaDetailProfilesModalComponent } from './components/media-detail-profiles-modal/media-detail-profiles-modal.component';
import { MediaDetailRootFolderModalComponent } from './components/media-detail-root-folder-modal/media-detail-root-folder-modal.component';
import { MediaDetailLibraryInfoComponent } from './components/media-detail-library-info/media-detail-library-info.component';
import {
  filesForEpisode,
  filterSeasonEpisodesOnDisk,
  seasonsVisibleWithDiskFilter,
  subtitlesForEpisode,
} from './media-detail.utils';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';

const LS_EPISODES_HAS_FILE_ONLY = 'suitarr.mediaDetail.episodesHasFileOnly';

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
    RouterLink,
    TranslateModule,
    MediaDetailHeaderComponent,
    MediaDetailLibraryInfoComponent,
    MediaDetailFilesComponent,
    MediaDetailSubtitlesComponent,
    MediaDetailSeasonsComponent,
    MediaDetailMovieDownloadComponent,
    MediaDetailSubtitleSearchModalComponent,
    ReleasesModalComponent,
    MediaDetailProfilesModalComponent,
    MediaDetailRootFolderModalComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail.html',
})
export class MediaDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly mediaService = inject(MediaService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);
  private readonly rootFoldersApi = inject(RootFoldersApiService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);

  readonly media = signal<Media | null>(null);
  readonly mediaFiles = computed(() => {
    const m = this.media();
    if (!m) return [];
    const list = m.files ?? [];
    return m.type === 'series' ? list.filter((f) => !f.episodeId) : list;
  });
  readonly loading = signal(true);
  readonly notFound = signal(false);
  readonly expectedKind = signal<'movie' | 'series'>('movie');

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
  readonly requiredSubtitleLangs = computed(() => {
    const m = this.media();
    const lpId = m?.languageProfile?.id;
    if (!lpId) return [];
    const lp = this.languageProfiles().find((p) => p.id === lpId);
    return lp?.subtitleLanguages ?? [];
  });
  readonly profilesOk = signal('');
  readonly profilesErr = signal('');

  readonly rootFolders = signal<RootFolder[]>([]);
  readonly selectedRootFolderId = signal<number | null>(null);
  readonly pathSaving = signal(false);
  readonly pathOk = signal(false);

  readonly canGrab = computed(() => {
    const r = this.auth.user()?.role;
    return r === 'admin' || r === 'user';
  });

  readonly canEditProfiles = computed(() => {
    const r = this.auth.user()?.role;
    return r === 'admin' || r === 'user';
  });

  readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
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

  readonly upgradeReleases = signal<MovieRelease[]>([]);
  readonly upgradeReleasesLoading = signal(false);
  readonly upgradeReleasesSearched = signal(false);
  readonly upgradeReleasesError = signal('');
  readonly upgradeGrabBusy = signal<string | null>(null);
  readonly upgradeGrabToast = signal('');
  readonly upgradeGrabState = signal<Map<string, 'ok' | 'error'>>(new Map());

  // Season grab
  readonly seasonGrabBusy = signal<string | null>(null);
  readonly seasonReleaseGrabState = signal<Map<string, 'ok' | 'error'>>(new Map());
  readonly seasonReleasesOpen = signal<number | null>(null);
  readonly seasonForReleases = signal<Season | null>(null);
  readonly seasonReleases = signal<MovieRelease[]>([]);
  readonly seasonReleasesLoading = signal(false);
  readonly seasonReleasesError = signal('');

  readonly movieReleasesModal = viewChild<ReleasesModalComponent>('movieReleasesModal');
  readonly upgradeReleasesModal = viewChild<ReleasesModalComponent>('upgradeReleasesModal');
  readonly episodeReleasesModal = viewChild<ReleasesModalComponent>('episodeReleasesModal');
  readonly seasonReleasesModal = viewChild<ReleasesModalComponent>('seasonReleasesModal');
  readonly profilesModal = viewChild(MediaDetailProfilesModalComponent);
  readonly rootFolderModal = viewChild(MediaDetailRootFolderModalComponent);
  readonly subtitleSearchModal = viewChild(MediaDetailSubtitleSearchModalComponent);

  // Subtitles
  readonly subtitles = signal<SubtitleFileRow[]>([]);
  readonly subtitlesLoading = signal(false);
  readonly subtitleActionBusy = signal(false);
  readonly subSearchLang = signal('en');
  readonly subSearchResults = signal<SubtitleSearchResult[]>([]);
  readonly subSearchLoading = signal(false);
  readonly subSearchSearched = signal(false);
  /** `null` = recherche depuis la fiche film ; sinon id épisode (drawer série). */
  readonly subtitleSearchEpisodeId = signal<number | null>(null);

  readonly episodeDialogSubtitles = computed(() => {
    const c = this.episodeDrawerContext();
    const m = this.media();
    if (!c || !m || m.type !== 'series') return [];
    return subtitlesForEpisode(this.subtitles(), c.episode.id, m.files);
  });

  readonly episodeDialogFiles = computed(() => {
    const c = this.episodeDrawerContext();
    const m = this.media();
    if (!c || !m?.files) return [];
    return filesForEpisode(m.files, c.episode.id);
  });

  async ngOnInit() {
    const kind = this.route.snapshot.data['kind'] as 'movie' | 'series';
    this.expectedKind.set(kind);
    const idParam = this.route.snapshot.paramMap.get('id');
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isFinite(id) || id < 1) {
      this.loading.set(false);
      this.notFound.set(true);
      return;
    }

    const role = this.auth.user()?.role;
    const loadProfiles = async () => {
      if (role !== 'admin' && role !== 'user') return;
      this.profilesOptionsLoading.set(true);
      try {
        const [q, l, rf] = await Promise.all([
          this.profilesApi.getQualityProfiles(),
          this.profilesApi.getLanguageProfiles(),
          this.rootFoldersApi.list(),
        ]);
        this.qualityProfileOptions.set(q.map((p) => ({ id: p.id, name: p.name })));
        this.languageProfiles.set(l);
        this.languageProfileOptions.set(l.map((p) => ({ id: p.id, name: p.name })));
        this.rootFolders.set(rf);
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
      if (m.type === 'series' && m.seasons?.length) {
        this.syncActiveSeasonForSeriesFilter();
      } else {
        this.activeSeasonId.set(null);
      }
      this.draftQualityProfileId.set(m.qualityProfile?.id ?? null);
      this.draftLanguageProfileId.set(m.languageProfile?.id ?? null);
      void this.loadSubtitles(m.id);
      // Match current path to a root folder
      const rf = this.rootFolders().find((r) => m.path?.startsWith(r.path));
      this.selectedRootFolderId.set(rf?.id ?? null);
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
    const rfId = this.selectedRootFolderId();
    const rf = this.rootFolders().find((r) => r.id === rfId);
    if (!rf) return;
    this.pathSaving.set(true);
    this.pathOk.set(false);
    try {
      const updated = await this.mediaService.patchPath(m.id, rf.path);
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
      const updated = await this.mediaService.refreshMetadata(m.id);
      this.media.set(updated);
      if (updated.type === 'series') this.syncActiveSeasonForSeriesFilter();
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

  selectSeason(seasonId: number) {
    this.activeSeasonId.set(seasonId);
    this.persistActiveSeason(seasonId);
  }

  private persistActiveSeason(seasonId: number | null) {
    const m = this.media();
    if (!m) return;
    try {
      if (seasonId != null) {
        sessionStorage.setItem(`suitarr.season.${m.id}`, String(seasonId));
      } else {
        sessionStorage.removeItem(`suitarr.season.${m.id}`);
      }
    } catch { /* private mode */ }
  }

  private restoreActiveSeason(): number | null {
    const m = this.media();
    if (!m) return null;
    try {
      const v = sessionStorage.getItem(`suitarr.season.${m.id}`);
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

  async loadUpgradeReleases() {
    const m = this.media();
    if (!m || m.type !== 'movie') return;
    this.upgradeReleasesLoading.set(true);
    this.upgradeReleasesError.set('');
    this.upgradeGrabToast.set('');
    this.upgradeReleases.set([]);
    this.upgradeReleasesSearched.set(false);
    this.upgradeReleasesModal()?.showModal();
    try {
      const rows = await this.mediaService.getUpgradeReleases(m.id, this.customSearchQuery());
      this.upgradeReleases.set(rows);
      this.upgradeReleasesSearched.set(true);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.upgradeReleases.set([]);
      this.upgradeReleasesSearched.set(true);
      this.upgradeReleasesError.set(
        httpErr.error?.message ?? this.translate.instant('media_detail.releases_error'),
      );
    } finally {
      this.upgradeReleasesLoading.set(false);
    }
  }

  async grabUpgradeBest() {
    const m = this.media();
    if (!m || m.type !== 'movie') return;
    this.upgradeGrabBusy.set('best');
    try {
      await this.mediaService.grabUpgrade(m.id, {});
      this.upgradeGrabState.update((s) => new Map(s).set('best', 'ok'));
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      this.upgradeGrabState.update((s) => new Map(s).set('best', 'error'));
      this.toast.error(this.translate.instant('media_detail.grab_error'));
    } finally {
      this.upgradeGrabBusy.set(null);
    }
  }

  async grabUpgradeRelease(r: MovieRelease, index: number) {
    const m = this.media();
    if (!m || m.type !== 'movie') return;
    const key = `u-${index}`;
    this.upgradeGrabBusy.set(key);
    try {
      await this.mediaService.grabUpgrade(m.id, { downloadUrl: r.downloadUrl, sourceTitle: r.title });
      this.upgradeGrabState.update((s) => new Map(s).set(key, 'ok'));
      this.toast.success(this.translate.instant('media_detail.grab_success'));
    } catch {
      this.upgradeGrabState.update((s) => new Map(s).set(key, 'error'));
      this.toast.error(this.translate.instant('media_detail.grab_error'));
    } finally {
      this.upgradeGrabBusy.set(null);
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

  // ── Subtitles ──────────────────────────────────────────────────────

  async loadSubtitles(mediaId: number) {
    this.subtitlesLoading.set(true);
    try {
      this.subtitles.set(await this.subtitlesApi.getForMedia(mediaId));
    } catch {
      this.subtitles.set([]);
    } finally {
      this.subtitlesLoading.set(false);
    }
  }

  async autoSubtitle() {
    const m = this.media();
    if (!m) return;
    const file = m.files?.[0];
    if (!file) return;
    this.subtitleActionBusy.set(true);
    try {
      await this.subtitlesApi.autoDownload(m.id, {
        mediaFileId: file.id,
        language: this.subSearchLang(),
      });
      await this.loadSubtitles(m.id);
    } finally {
      this.subtitleActionBusy.set(false);
    }
  }

  openSubtitleSearch() {
    this.subtitleSearchEpisodeId.set(null);
    this.subSearchResults.set([]);
    this.subSearchSearched.set(false);
    this.subtitleSearchModal()?.showModal();
  }

  onEpisodeOpenSubtitleSearch() {
    const c = this.episodeDrawerContext();
    if (!c) return;
    this.subtitleSearchEpisodeId.set(c.episode.id);
    this.subSearchResults.set([]);
    this.subSearchSearched.set(false);
    this.subtitleSearchModal()?.showModal();
  }

  async searchSubtitles() {
    const m = this.media();
    if (!m) return;
    const epId = this.subtitleSearchEpisodeId();
    this.subSearchLoading.set(true);
    this.subSearchSearched.set(false);
    this.subSearchResults.set([]);
    try {
      const results = await this.subtitlesApi.search(
        m.id,
        this.subSearchLang(),
        epId ?? undefined,
      );
      this.subSearchResults.set(results);
    } catch {
      this.subSearchResults.set([]);
    } finally {
      this.subSearchLoading.set(false);
      this.subSearchSearched.set(true);
    }
  }

  async downloadSearchResult(r: SubtitleSearchResult) {
    const m = this.media();
    if (!m?.files?.length) return;
    const epId = this.subtitleSearchEpisodeId();
    let mediaFileId: number;
    if (epId != null) {
      const file = m.files.find((f) => f.episodeId === epId);
      if (!file) return;
      mediaFileId = file.id;
    } else {
      mediaFileId = m.files[0].id;
    }
    this.subtitleActionBusy.set(true);
    try {
      await this.subtitlesApi.download(m.id, {
        searchResult: r,
        mediaFileId,
        episodeId: epId ?? undefined,
      });
      await this.loadSubtitles(m.id);
    } finally {
      this.subtitleActionBusy.set(false);
    }
  }

  async syncSubtitle(subtitleId: number) {
    const m = this.media();
    if (!m) return;
    this.subtitleActionBusy.set(true);
    try {
      await this.subtitlesApi.sync(m.id, subtitleId);
      await this.loadSubtitles(m.id);
    } finally {
      this.subtitleActionBusy.set(false);
    }
  }

  async deleteSubtitle(subtitleId: number) {
    const m = this.media();
    if (!m) return;
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('media_detail.confirm_delete_subtitle'), variant: 'danger' })) return;
    this.subtitleActionBusy.set(true);
    try {
      await this.subtitlesApi.delete(m.id, subtitleId);
      await this.loadSubtitles(m.id);
    } finally {
      this.subtitleActionBusy.set(false);
    }
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
