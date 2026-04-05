import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CastService } from '../../core/services/cast.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Media, MediaService, Season, Episode } from '../../core/services/api/media.service';
import { ProfilesService, LanguageProfile } from '../../core/services/api/profiles.service';
import { SubtitlesApiService, SubtitleFileRow } from '../../core/services/api/subtitles-api.service';
import { MediaDetailSubtitlesComponent } from '../media-detail/components/media-detail-subtitles/media-detail-subtitles.component';
import { MediaFileInfoComponent } from '../../shared/components/media-file-info';
import { MediaDetailSubtitleSearchModalComponent } from '../media-detail/components/media-detail-subtitle-search-modal/media-detail-subtitle-search-modal.component';
import { ReleasesModalComponent } from '../media-detail/components/releases-modal/releases-modal.component';
import {
  displayMediaFilePath,
  filesForEpisode,
  formatMediaDetailBytes,
  subtitlesForEpisode,
} from '../media-detail/media-detail.utils';
import type { MediaFileRow } from '../media-detail/media-detail.utils';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';
import {
  LucideChevronLeft,
  LucideTrash2,
  LucideEllipsisVertical,
  LucideDownload,
  LucideSearch,
  LucideEyeOff,
  LucideEye,
  LucideRotateCcw,
  LucideFileText,
} from '@lucide/angular';

@Component({
  selector: 'app-episode-detail',
  imports: [
    RouterLink,
    FormsModule,
    TranslateModule,
    MediaDetailSubtitlesComponent,
    MediaFileInfoComponent,
    MediaDetailSubtitleSearchModalComponent,
    ReleasesModalComponent,
    LucideChevronLeft,
    LucideTrash2,
    LucideEllipsisVertical,
    LucideDownload,
    LucideSearch,
    LucideEyeOff,
    LucideEye,
    LucideRotateCcw,
    LucideFileText,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './episode-detail.html',
})
export class EpisodeDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly mediaService = inject(MediaService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly auth = inject(AuthService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  readonly castService = inject(CastService);
  private readonly castPlayer = inject(CastPlayerService);

  readonly loading = signal(true);
  readonly notFound = signal(false);
  readonly media = signal<Media | null>(null);
  readonly season = signal<Season | null>(null);
  readonly episode = signal<Episode | null>(null);

  readonly subtitles = signal<SubtitleFileRow[]>([]);
  readonly subtitlesLoading = signal(false);
  readonly subtitleActionBusy = signal(false);

  readonly episodeBusy = signal(false);
  readonly refreshLoading = signal(false);
  readonly rescanLoading = signal(false);

  readonly epReleasesLoading = signal(false);
  readonly epReleases = signal<any[]>([]);
  readonly epReleasesSearched = signal(false);
  readonly epReleasesError = signal('');
  readonly epGrabBusy = signal<string | null>(null);
  readonly epGrabState = signal<Map<string, 'ok' | 'error'>>(new Map());

  readonly subSearchLang = signal('en');
  readonly subSearchLoading = signal(false);
  readonly subSearchSearched = signal(false);
  readonly subSearchResults = signal<any[]>([]);

  readonly languageProfiles = signal<LanguageProfile[]>([]);
  readonly requiredSubtitleLangs = computed(() => {
    const m = this.media();
    const lpId = m?.languageProfile?.id;
    if (!lpId) return [];
    const lp = this.languageProfiles().find((p) => p.id === lpId);
    return lp?.subtitleLanguages ?? [];
  });

  readonly isAdmin = computed(() => this.auth.hasPermission('settings.access'));
  readonly canGrab = computed(() => this.auth.hasPermission('media.grab'));

  readonly selectedFileId = signal<number | null>(null);
  readonly activeFileId = computed(() => this.selectedFileId() ?? this.episodeFiles()[0]?.id ?? null);

  readonly episodeFiles = computed<MediaFileRow[]>(() => {
    const m = this.media();
    const ep = this.episode();
    if (!m?.files || !ep) return [];
    return filesForEpisode(m.files, ep.id);
  });

  /** Auto-select first file when episodeFiles change */
  private readonly autoSelectFileEffect = effect(() => {
    const files = this.episodeFiles();
    const current = this.selectedFileId();
    if (files.length && (!current || !files.some((f) => f.id === current))) {
      this.selectedFileId.set(files[0].id);
    }
  });

  readonly selectedFile = computed(() => {
    const files = this.episodeFiles();
    const id = this.selectedFileId();
    return files.find((f) => f.id === id) ?? files[0] ?? null;
  });

  readonly episodeSubtitles = computed<SubtitleFileRow[]>(() => {
    const m = this.media();
    const ep = this.episode();
    if (!m || !ep) return [];
    return subtitlesForEpisode(this.subtitles(), ep.id, m.files);
  });

  /** Subtitles filtered by selected file when multiple files exist */
  readonly selectedFileSubtitles = computed<SubtitleFileRow[]>(() => {
    const all = this.episodeSubtitles();
    const fileId = this.selectedFileId();
    if (!fileId || this.episodeFiles().length <= 1) return all;
    return all.filter((s) => s.mediaFileId === fileId);
  });

  readonly seriesRoute = computed(() => {
    const m = this.media();
    return m ? ['/series', String(m.id)] : ['/series'];
  });

  readonly seriesQueryParams = computed(() => {
    const s = this.season();
    return s ? { season: s.seasonNumber } : {};
  });

  readonly episodeReleasesModal = viewChild<ReleasesModalComponent>('episodeReleasesModal');
  readonly subtitleSearchModal = viewChild(MediaDetailSubtitleSearchModalComponent);

  ngOnInit() {
    this.loadData();
  }

  private async loadData() {
    const mediaId = Number(this.route.snapshot.paramMap.get('id'));
    const episodeId = Number(this.route.snapshot.paramMap.get('episodeId'));

    if (!mediaId || !episodeId) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }

    // Load language profiles in parallel (non-blocking)
    void this.profilesApi.getLanguageProfiles().then(
      (lps) => this.languageProfiles.set(lps),
      () => {},
    );

    try {
      const [media, subs] = await Promise.all([
        this.mediaService.getOne(mediaId),
        this.subtitlesApi.getForMedia(mediaId),
      ]);

      this.media.set(media);
      this.subtitles.set(subs);

      let foundSeason: Season | null = null;
      let foundEpisode: Episode | null = null;
      for (const s of media.seasons ?? []) {
        const ep = s.episodes?.find((e) => e.id === episodeId);
        if (ep) {
          foundSeason = s;
          foundEpisode = ep;
          break;
        }
      }

      if (!foundEpisode) {
        this.notFound.set(true);
      } else {
        this.season.set(foundSeason);
        this.episode.set(foundEpisode);
      }
    } catch {
      this.notFound.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  async refreshMetadata() {
    const m = this.media();
    if (!m) return;
    this.refreshLoading.set(true);
    try {
      const updated = await this.mediaService.refreshMetadata(m.id);
      this.media.set(updated);
      // Re-resolve episode from refreshed data
      const ep = this.episode();
      if (ep) {
        for (const s of updated.seasons ?? []) {
          const freshEp = s.episodes?.find((e) => e.id === ep.id);
          if (freshEp) {
            this.season.set(s);
            this.episode.set(freshEp);
            break;
          }
        }
      }
      const subs = await this.subtitlesApi.getForMedia(m.id);
      this.subtitles.set(subs);
    } finally {
      this.refreshLoading.set(false);
    }
  }

  async rescanFiles() {
    const m = this.media();
    if (!m) return;
    this.rescanLoading.set(true);
    try {
      const result = await this.mediaService.rescanFiles(m.id);
      if (result.added || result.removed || result.updated) {
        const updated = await this.mediaService.getOne(m.id);
        this.media.set(updated);
        // Re-resolve episode
        const ep = this.episode();
        if (ep) {
          for (const s of updated.seasons ?? []) {
            const freshEp = s.episodes?.find((e) => e.id === ep.id);
            if (freshEp) {
              this.season.set(s);
              this.episode.set(freshEp);
              break;
            }
          }
        }
        const subs = await this.subtitlesApi.getForMedia(m.id);
        this.subtitles.set(subs);
      }
      this.toast.success(
        this.translate.instant('media_detail.rescan_ok', {
          added: result.added,
          removed: result.removed,
          updated: result.updated,
        }),
      );
    } catch {
      // handled by global interceptor
    } finally {
      this.rescanLoading.set(false);
    }
  }

  async toggleMonitored() {
    const ep = this.episode();
    if (!ep) return;
    this.episodeBusy.set(true);
    try {
      await this.mediaService.updateEpisodeMonitored(ep.id, !ep.monitored);
      this.episode.set({ ...ep, monitored: !ep.monitored });
    } finally {
      this.episodeBusy.set(false);
    }
  }

  async loadReleases() {
    const m = this.media();
    const ep = this.episode();
    if (!m || !ep) return;
    this.epReleasesLoading.set(true);
    this.epReleasesError.set('');
    this.epGrabState.set(new Map());
    this.episodeReleasesModal()?.showModal();
    try {
      const releases = await this.mediaService.getEpisodeReleases(m.id, ep.id);
      this.epReleases.set(releases);
      this.epReleasesSearched.set(true);
    } catch (e: any) {
      this.epReleasesError.set(e?.error?.message ?? 'Error');
    } finally {
      this.epReleasesLoading.set(false);
    }
  }

  async grabBest() {
    const m = this.media();
    const ep = this.episode();
    if (!m || !ep) return;
    this.epGrabBusy.set('best');
    try {
      await this.mediaService.grabEpisode(m.id, ep.id, {});
      this.toast.success('Téléchargement lancé');
    } catch {
      this.toast.error('Erreur lors du téléchargement');
    } finally {
      this.epGrabBusy.set(null);
    }
  }

  async grabRelease(release: any, index: number) {
    const m = this.media();
    const ep = this.episode();
    if (!m || !ep) return;
    const key = `ep-${index}`;
    this.epGrabBusy.set(key);
    try {
      await this.mediaService.grabEpisode(m.id, ep.id, {
        downloadUrl: release.downloadUrl,
        sourceTitle: release.title,
      });
      this.epGrabState.update((s) => new Map(s).set(key, 'ok'));
      this.toast.success('Téléchargement lancé');
    } catch {
      this.epGrabState.update((s) => new Map(s).set(key, 'error'));
      this.toast.error('Erreur lors du téléchargement');
    } finally {
      this.epGrabBusy.set(null);
    }
  }

  async syncSubtitle(event: { subtitleId: number; options: import('../../core/services/api/subtitles-api.service').SyncOptions }) {
    const m = this.media();
    if (!m) return;
    this.toast.info(this.translate.instant('media_detail.sync_started'));
    try {
      await this.subtitlesApi.sync(m.id, event.subtitleId, event.options);
      // Success toast will come from SSE when sync actually completes
    } catch {
      // handled by global interceptor
    }
  }

  async postProcessSubtitle(event: { subtitleId: number; action: string; params?: Record<string, unknown> }) {
    const m = this.media();
    if (!m) return;
    try {
      await this.subtitlesApi.postProcess(m.id, event.subtitleId, event.action, event.params);
      this.toast.success(this.translate.instant('media_detail.post_process_success'));
    } catch {
      // handled by global interceptor
    }
  }

  async blacklistSubtitle(sub: import('../../core/services/api/subtitles-api.service').SubtitleFileRow) {
    const m = this.media();
    if (!m) return;
    try {
      await this.subtitlesApi.addToBlacklist({
        providerType: sub.providerType,
        providerFileId: sub.providerFileId,
        mediaId: m.id,
        language: sub.language,
        sourceTitle: sub.providerFileId,
        reason: 'Manually blacklisted',
      });
      await this.subtitlesApi.delete(m.id, sub.id);
      this.toast.success(this.translate.instant('media_detail.blacklist_success'));
      this.subtitles.update((list) => list.filter((s) => s.id !== sub.id));
    } catch {
      // handled by global interceptor
    }
  }

  async deleteSubtitle(subtitleId: number) {
    const m = this.media();
    if (!m) return;
    this.subtitleActionBusy.set(true);
    try {
      await this.subtitlesApi.delete(m.id, subtitleId);
      this.subtitles.update((list) => list.filter((s) => s.id !== subtitleId));
    } finally {
      this.subtitleActionBusy.set(false);
    }
  }

  async onDeleteFileClick() {
    const fileId = this.selectedFileId();
    if (!fileId) return;
    const result = await this.confirmation.choose({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('media_detail.confirm_delete_file_disk'),
      confirmLabel: this.translate.instant('media_detail.delete_file_disk'),
      cancelLabel: this.translate.instant('media_detail.untrack_file'),
      dismissLabel: this.translate.instant('common.cancel'),
      variant: 'danger',
    });
    if (result === null) return;
    await this.deleteFile(fileId, result);
  }

  async deleteFile(fileId: number, deleteOnDisk: boolean) {
    const m = this.media();
    if (!m) return;
    await this.mediaService.deleteFile(m.id, fileId, deleteOnDisk);
    this.media.set({ ...m, files: (m.files ?? []).filter((f) => f.id !== fileId) });
  }

  async autoSubtitle() {
    const m = this.media();
    const ep = this.episode();
    if (!m || !ep) return;
    const fileId = this.activeFileId();
    if (!fileId) return;
    this.subtitleActionBusy.set(true);
    try {
      await this.subtitlesApi.autoDownload(m.id, {
        mediaFileId: fileId,
        episodeId: ep.id,
        language: this.subSearchLang(),
      });
      this.subtitles.set(await this.subtitlesApi.getForMedia(m.id));
    } finally {
      this.subtitleActionBusy.set(false);
    }
  }

  openSubtitleSearch() {
    this.subSearchResults.set([]);
    this.subSearchSearched.set(false);
    this.subtitleSearchModal()?.showModal();
  }

  async searchSubtitles() {
    const m = this.media();
    const ep = this.episode();
    if (!m || !ep) return;
    this.subSearchLoading.set(true);
    try {
      const results = await this.subtitlesApi.search(m.id, this.subSearchLang(), ep.id);
      this.subSearchResults.set(results);
      this.subSearchSearched.set(true);
    } finally {
      this.subSearchLoading.set(false);
    }
  }

  async downloadSearchResult(result: any) {
    const m = this.media();
    const ep = this.episode();
    if (!m || !ep) return;
    const fileId = this.activeFileId();
    if (!fileId) return;
    this.subtitleActionBusy.set(true);
    try {
      await this.subtitlesApi.download(m.id, {
        searchResult: result,
        mediaFileId: fileId,
        episodeId: ep.id,
      });
      const subs = await this.subtitlesApi.getForMedia(m.id);
      this.subtitles.set(subs);
    } finally {
      this.subtitleActionBusy.set(false);
    }
  }

  formatBytes(bytes: number): string {
    return formatMediaDetailBytes(bytes);
  }

  async play(fromStart: boolean) {
    const fileId = this.selectedFileId();
    if (!fileId) return;
    const m = this.media();
    const ep = this.episode();

    if (this.castService.isConnected() && m) {
      const file = this.episodeFiles().find(f => f.id === fileId);
      await this.castPlayer.quickStart({
        mediaFileId: fileId,
        mediaId: m.id,
        episodeId: ep?.id,
        title: m.title,
        episodeTitle: ep ? `S${String(this.season()?.seasonNumber ?? 0).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')} - ${ep.title}` : undefined,
        fanartUrl: m.posterUrl ?? null,
        streamInfo: file?.streamInfo,
        startTime: fromStart ? 0 : undefined,
      });
      this.castPlayer.expanded.set(true);
    } else {
      const qp: any = { mediaId: m?.id, episodeId: ep?.id };
      if (fromStart) qp.t = 0;
      this.router.navigate(['/watch', fileId], { queryParams: qp });
    }
  }

  fileDiskPath(relativePath: string): string {
    return displayMediaFilePath(this.media()?.path, relativePath);
  }

  pad(n: number): string {
    return String(n).padStart(2, '0');
  }

}
