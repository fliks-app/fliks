import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  computed,
  OnInit,
  viewChild,
  ElementRef,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  MediaService,
  Media,
  Season,
  Episode,
  MovieRelease,
} from '../../core/services/api/media.service';
import { AuthService } from '../../core/services/auth.service';
import { ProfilesService } from '../../core/services/api/profiles.service';
import {
  RootFoldersApiService,
  RootFolder,
} from '../../core/services/api/root-folders-api.service';

@Component({
  selector: 'app-media-detail',
  imports: [RouterLink, DecimalPipe, TranslateModule, FormsModule],
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

  readonly media = signal<Media | null>(null);
  readonly loading = signal(true);
  readonly notFound = signal(false);
  readonly expectedKind = signal<'movie' | 'series'>('movie');

  readonly releases = signal<MovieRelease[]>([]);
  readonly releasesLoading = signal(false);
  readonly releasesSearched = signal(false);
  readonly releasesError = signal('');
  readonly grabBusy = signal<string | null>(null);
  readonly grabToast = signal('');
  readonly grabState = signal<Map<string, 'ok' | 'error'>>(new Map());

  readonly qualityProfileOptions = signal<{ id: number; name: string }[]>([]);
  readonly languageProfileOptions = signal<{ id: number; name: string }[]>([]);
  readonly profilesOptionsLoading = signal(false);
  readonly draftQualityProfileId = signal<number | null>(null);
  readonly draftLanguageProfileId = signal<number | null>(null);
  readonly profilesSaveLoading = signal(false);
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
  readonly monitoredLoading = signal(false);
  readonly refreshLoading = signal(false);
  readonly refreshToast = signal('');
  readonly expandedSeasonId = signal<number | null>(null);
  readonly seasonBusy = signal<number | null>(null);
  readonly episodeBusy = signal<number | null>(null);

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
  readonly seasonGrabBusy = signal<number | null>(null);
  readonly seasonReleaseGrabState = signal<Map<string, 'ok' | 'error'>>(new Map());
  readonly seasonGrabResults = signal<Map<number, { grabbed: number; errors: string[] }>>(new Map());
  readonly seasonReleasesOpen = signal<number | null>(null);
  readonly seasonForReleases = signal<Season | null>(null);
  readonly seasonReleases = signal<MovieRelease[]>([]);
  readonly seasonReleasesLoading = signal(false);
  readonly seasonReleasesError = signal('');

  // Modal dialog refs
  readonly movieReleasesDialog = viewChild<ElementRef<HTMLDialogElement>>('movieReleasesModal');
  readonly upgradeReleasesDialog = viewChild<ElementRef<HTMLDialogElement>>('upgradeReleasesModal');
  readonly episodeReleasesDialog = viewChild<ElementRef<HTMLDialogElement>>('episodeReleasesModal');
  readonly seasonReleasesDialog = viewChild<ElementRef<HTMLDialogElement>>('seasonReleasesModal');
  readonly profilesDialog = viewChild<ElementRef<HTMLDialogElement>>('profilesModal');
  readonly rootFolderDialog = viewChild<ElementRef<HTMLDialogElement>>('rootFolderModal');

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
    if (role === 'admin' || role === 'user') {
      this.profilesOptionsLoading.set(true);
      try {
        const [q, l, rf] = await Promise.all([
          this.profilesApi.getQualityProfiles(),
          this.profilesApi.getLanguageProfiles(),
          this.rootFoldersApi.list(),
        ]);
        this.qualityProfileOptions.set(q.map((p) => ({ id: p.id, name: p.name })));
        this.languageProfileOptions.set(l.map((p) => ({ id: p.id, name: p.name })));
        this.rootFolders.set(rf);
      } finally {
        this.profilesOptionsLoading.set(false);
      }
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
      this.draftQualityProfileId.set(m.qualityProfile?.id ?? null);
      this.draftLanguageProfileId.set(m.languageProfile?.id ?? null);
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
    this.rootFolderDialog()?.nativeElement.showModal();
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
    this.movieReleasesDialog()?.nativeElement.showModal();
    try {
      const rows = await this.mediaService.getMovieReleases(m.id);
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
    } catch {
      this.grabState.update((s) => new Map(s).set('best', 'error'));
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
    } finally {
      this.monitoredLoading.set(false);
    }
  }

  async deleteMedia() {
    const m = this.media();
    if (!m) return;
    if (!confirm(this.translate.instant('media_detail.confirm_delete', { title: m.title }))) return;
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
    this.profilesDialog()?.nativeElement.showModal();
  }

  async refreshMetadata() {
    const m = this.media();
    if (!m) return;
    this.refreshLoading.set(true);
    this.refreshToast.set('');
    try {
      const updated = await this.mediaService.refreshMetadata(m.id);
      this.media.set(updated);
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

  toggleSeasonExpanded(seasonId: number) {
    this.expandedSeasonId.set(
      this.expandedSeasonId() === seasonId ? null : seasonId,
    );
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
      this.media.set({
        ...m,
        seasons: m.seasons.map((s) =>
          s.id === seasonId
            ? {
                ...s,
                episodes: s.episodes.map((e) =>
                  e.id === updated.id
                    ? { ...e, monitored: updated.monitored }
                    : e,
                ),
              }
            : s,
        ),
      });
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
    this.episodeReleasesDialog()?.nativeElement.showModal();
    try {
      const rows = await this.mediaService.getEpisodeReleases(mediaId, episodeId);
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
      await this.mediaService.grabEpisode(mediaId, episodeId, { downloadUrl: r.downloadUrl, sourceTitle: r.title });
      this.epGrabState.update((s) => new Map(s).set(key, 'ok'));
    } catch {
      this.epGrabState.update((s) => new Map(s).set(key, 'error'));
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
    this.upgradeReleasesDialog()?.nativeElement.showModal();
    try {
      const rows = await this.mediaService.getUpgradeReleases(m.id);
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
    } catch {
      this.upgradeGrabState.update((s) => new Map(s).set('best', 'error'));
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
    } catch {
      this.upgradeGrabState.update((s) => new Map(s).set(key, 'error'));
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
    this.seasonReleasesDialog()?.nativeElement.showModal();
    try {
      const rows = await this.mediaService.getSeasonReleases(mediaId, season.id);
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
    this.seasonGrabBusy.set(season.id);
    try {
      const result = await this.mediaService.grabSeason(mediaId, season.id, {});
      this.seasonGrabResults.update((m) => new Map(m).set(season.id, result));
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.seasonGrabResults.update((m) =>
        new Map(m).set(season.id, {
          grabbed: 0,
          errors: [httpErr.error?.message ?? this.translate.instant('media_detail.grab_error')],
        }),
      );
    } finally {
      this.seasonGrabBusy.set(null);
    }
  }

  async grabSeasonRelease(mediaId: number, season: Season, r: MovieRelease, index: number) {
    const key = `s-${index}`;
    this.seasonGrabBusy.set(season.id);
    try {
      const result = await this.mediaService.grabSeason(mediaId, season.id, {
        downloadUrl: r.downloadUrl,
        sourceTitle: r.title,
      });
      this.seasonGrabResults.update((m) => new Map(m).set(season.id, result));
      this.seasonReleaseGrabState.update((s) => new Map(s).set(key, 'ok'));
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.seasonGrabResults.update((m) =>
        new Map(m).set(season.id, {
          grabbed: 0,
          errors: [httpErr.error?.message ?? this.translate.instant('media_detail.grab_error')],
        }),
      );
      this.seasonReleaseGrabState.update((s) => new Map(s).set(key, 'error'));
    } finally {
      this.seasonGrabBusy.set(null);
    }
  }

  seasonGrabResult(seasonId: number) {
    return this.seasonGrabResults().get(seasonId) ?? null;
  }

  async deleteFile(fileId: number, deleteOnDisk: boolean) {
    const m = this.media();
    if (!m) return;
    const msg = deleteOnDisk
      ? this.translate.instant('media_detail.confirm_delete_file_disk')
      : this.translate.instant('media_detail.confirm_delete_file');
    if (!confirm(msg)) return;
    try {
      await this.mediaService.deleteFile(m.id, fileId, deleteOnDisk);
      this.media.update((media) =>
        media ? { ...media, files: media.files?.filter((f) => f.id !== fileId) } : media,
      );
    } catch {
      // ignore
    }
  }

  formatBytes(bytes: number): string {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
  }

  async grabRelease(r: MovieRelease, index: number) {
    const m = this.media();
    if (!m || m.type !== 'movie') return;
    const key = `r-${index}`;
    this.grabBusy.set(key);
    try {
      await this.mediaService.grabMovie(m.id, { downloadUrl: r.downloadUrl, sourceTitle: r.title });
      this.grabState.update((s) => new Map(s).set(key, 'ok'));
    } catch {
      this.grabState.update((s) => new Map(s).set(key, 'error'));
    } finally {
      this.grabBusy.set(null);
    }
  }
}
