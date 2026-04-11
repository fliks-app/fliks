import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { PlayableMediaService } from '../../core/services/playable-media.service';
import { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { SubtitleActionsService } from '../../core/services/subtitle-actions.service';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Media, MediaService, Season, Episode, MediaCastEntry, MediaCrewEntry } from '../../core/services/api/media.service';
import { ProfilesService, LanguageProfile } from '../../core/services/api/profiles.service';
import { SubtitlesApiService, SubtitleFileRow } from '../../core/services/api/subtitles-api.service';
import { MediaDetailSubtitlesComponent } from '../media-detail/components/media-detail-subtitles/media-detail-subtitles.component';
import { MediaFileInfoComponent } from '../../shared/components/media-file-info';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { DownloadQualityModalComponent } from '../../shared/components/download-quality-modal/download-quality-modal';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import { MediaDetailSubtitleSearchModalComponent } from '../media-detail/components/media-detail-subtitle-search-modal/media-detail-subtitle-search-modal.component';
import { ReleasesModalComponent } from '../media-detail/components/releases-modal/releases-modal.component';
import {
  displayMediaFilePath,
  fileQualityOptionLabel,
  filesForEpisode,
  formatMediaDetailBytes,
  hasMultipleFileQualityChoices,
  subtitlesForEpisode,
} from '../media-detail/media-detail.utils';
import type { MediaFileRow } from '../media-detail/media-detail.utils';
import { AuthService } from '../../core/services/auth.service';
import { NavbarService } from '../../core/services/navbar.service';
import { MobileFanartHeroComponent } from '../../shared/components/mobile-fanart-hero';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';
import { SseService } from '../../core/services/sse.service';
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
  LucideCircleCheck,
} from '@lucide/angular';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';

@Component({
  selector: 'app-episode-detail',
  imports: [
    DatePipe,
    RouterLink,
    FormsModule,
    TranslateModule,
    ResolveUrlPipe,
    MobileFanartHeroComponent,
    MediaDetailSubtitlesComponent,
    MediaFileInfoComponent,
    MediaDetailSubtitleSearchModalComponent,
    ReleasesModalComponent,
    HorizontalScrollerComponent,
    DownloadQualityModalComponent,
    LucideChevronLeft,
    LucideTrash2,
    LucideEllipsisVertical,
    LucideDownload,
    LucideSearch,
    LucideEyeOff,
    LucideEye,
    LucideRotateCcw,
    LucideFileText,
    LucideCircleCheck,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './episode-detail.html',
})
export class EpisodeDetailComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly mediaService = inject(MediaService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly auth = inject(AuthService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  readonly playable = inject(PlayableMediaService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly downloadManager = inject(DownloadManagerService);
  private readonly downloadModal = viewChild<DownloadQualityModalComponent>('downloadModal');
  private readonly subActions = inject(SubtitleActionsService);
  private readonly sse = inject(SseService);
  private readonly navbar = inject(NavbarService);
  readonly watched = signal(false);

  /** React to SSE rescan events for this media */
  private readonly sseEffect = effect(() => {
    const event = this.sse.lastEvent();
    const m = this.media();
    if (!event || !m) return;
    const eventMediaId = event['mediaId'] as number | undefined;
    if (eventMediaId !== m.id) return;

    if (event.type === 'rescan.completed') {
      void this.reloadAfterRescan(m.id);
    }
  });

  readonly loading = signal(true);
  readonly notFound = signal(false);
  readonly media = signal<Media | null>(null);
  readonly cast = signal<MediaCastEntry[]>([]);
  readonly crew = signal<MediaCrewEntry[]>([]);
  readonly season = signal<Season | null>(null);
  readonly episode = signal<Episode | null>(null);
  readonly resumeLabel = signal<string | null>(null);

  readonly subtitles = signal<SubtitleFileRow[]>([]);
  readonly subtitlesLoading = signal(false);
  readonly subtitleActionBusy = signal(false);

  readonly episodeBusy = signal(false);
  readonly refreshLoading = signal(false);

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

  readonly episodeQualitySelectVisible = computed(() =>
    hasMultipleFileQualityChoices(this.episodeFiles()),
  );

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

  ngOnDestroy() {
    this.navbar.leaveHeroPage();
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
      // Load cast/crew async
      this.mediaService.getCast(mediaId).then((c) => this.cast.set(c)).catch(() => {});
      this.mediaService.getCrew(mediaId).then((c) => this.crew.set(c)).catch(() => {});

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
        this.navbar.enterHeroPage(this.episodePageHeading(media, foundSeason!, foundEpisode));
        // Load watched status
        const fileId = this.activeFileId();
        if (fileId) {
          this.playable.loadWatchedState(fileId).then(v => this.watched.set(v));
          this.streamingApi.getPlaybackState(fileId).then((ps) => {
            if (ps && !ps.completed && ps.positionSeconds > 10) {
              const s = Math.floor(ps.positionSeconds);
              const h = Math.floor(s / 3600);
              const m = Math.floor((s % 3600) / 60);
              const sec = s % 60;
              this.resumeLabel.set(
                h > 0
                  ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
                  : `${m}:${String(sec).padStart(2, '0')}`,
              );
            } else {
              this.resumeLabel.set(null);
            }
          }).catch(() => {});
        }
      }
    } catch {
      this.notFound.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private episodePageHeading(m: Media, s: Season, ep: Episode): string {
    const sn = String(s.seasonNumber).padStart(2, '0');
    const en = String(ep.episodeNumber).padStart(2, '0');
    const epTitle = ep.title?.trim()
      ? ep.title
      : this.translate.instant('media_detail.ep_no_title');
    return `${m.title} — S${sn}:E${en} — ${epTitle}`;
  }

  async refreshMetadata() {
    const m = this.media();
    const ep = this.episode();
    if (!m || !ep) return;
    this.refreshLoading.set(true);
    try {
      const updated = await this.mediaService.refreshEpisodeMetadata(m.id, ep.id);
      this.media.set(updated);
      // Re-resolve episode from refreshed data
      for (const s of updated.seasons ?? []) {
        const freshEp = s.episodes?.find((e) => e.id === ep.id);
        if (freshEp) {
          this.season.set(s);
          this.episode.set(freshEp);
          break;
        }
      }
      const subs = await this.subtitlesApi.getForMedia(m.id);
      this.subtitles.set(subs);
      const s = this.season();
      const e = this.episode();
      if (s && e) this.navbar.enterHeroPage(this.episodePageHeading(updated, s, e));
    } finally {
      this.refreshLoading.set(false);
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
      const subs = await this.subtitlesApi.getForMedia(mediaId);
      this.subtitles.set(subs);
    } catch { /* ignore */ }
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
      this.toast.success(this.translate.instant('downloads.started'));
    } catch {
      this.toast.error(this.translate.instant('downloads.error'));
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
      this.toast.success(this.translate.instant('downloads.started'));
    } catch {
      this.epGrabState.update((s) => new Map(s).set(key, 'error'));
      this.toast.error(this.translate.instant('downloads.error'));
    } finally {
      this.epGrabBusy.set(null);
    }
  }

  async syncSubtitle(event: { subtitleId: number; options: import('../../core/services/api/subtitles-api.service').SyncOptions }) {
    const m = this.media();
    if (m) await this.subActions.sync(m.id, event.subtitleId, event.options);
  }

  async postProcessSubtitle(event: { subtitleId: number; action: string; params?: Record<string, unknown> }) {
    const m = this.media();
    if (m) await this.subActions.postProcess(m.id, event.subtitleId, event.action, event.params);
  }

  async blacklistSubtitle(sub: import('../../core/services/api/subtitles-api.service').SubtitleFileRow) {
    const m = this.media();
    if (m) await this.subActions.blacklist(m.id, sub, this.subtitles);
  }

  async deleteSubtitle(subtitleId: number) {
    const m = this.media();
    if (m) await this.subActions.remove(m.id, subtitleId, this.subtitles, this.subtitleActionBusy);
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
    const fileId = this.activeFileId();
    if (!m || !ep || !fileId) return;
    await this.subActions.autoDownload(m.id, fileId, this.subSearchLang(), this.subtitles, this.subtitleActionBusy, ep.id);
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
      this.subSearchResults.set(await this.subActions.search(m.id, this.subSearchLang(), ep.id));
      this.subSearchSearched.set(true);
    } finally {
      this.subSearchLoading.set(false);
    }
  }

  async downloadSearchResult(result: any) {
    const m = this.media();
    const ep = this.episode();
    const fileId = this.activeFileId();
    if (!m || !ep || !fileId) return;
    await this.subActions.download(m.id, fileId, result, this.subtitles, this.subtitleActionBusy, ep.id);
  }

  async toggleWatched() {
    const fileId = this.selectedFileId();
    const m = this.media();
    if (!fileId || !m) return;
    try { this.watched.set(await this.playable.toggleWatched(fileId, m.id, this.episode()?.id)); } catch { /* ignore */ }
  }

  formatBytes(bytes: number): string {
    return formatMediaDetailBytes(bytes);
  }

  qualityOptionLabel(f: MediaFileRow): string {
    return fileQualityOptionLabel(f, this.episodeFiles());
  }

  async play(fromStart: boolean) {
    const fileId = this.selectedFileId();
    if (!fileId) return;
    const m = this.media();
    const ep = this.episode();
    if (!m) return;
    const file = this.episodeFiles().find(f => f.id === fileId);
    const sn = this.season()?.seasonNumber ?? 0;
    await this.playable.play({
      fileId, mediaId: m.id, episodeId: ep?.id, title: m.title,
      episodeTitle: ep ? `S${String(sn).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')} - ${ep.title}` : undefined,
      fanartUrl: m.posterUrl ?? null, streamInfo: file?.streamInfo,
    }, fromStart);
  }

  fileDiskPath(relativePath: string): string {
    return displayMediaFilePath(this.media()?.path, relativePath);
  }

  pad(n: number): string {
    return String(n).padStart(2, '0');
  }

  openDownloadModal() {
    const fileId = this.selectedFileId();
    if (fileId) this.downloadModal()?.open(fileId);
  }

  async onDownload(ev: { mediaFileId: number; quality: string }) {
    try {
      const m = this.media();
      const ep = this.episode();
      const s = this.season();
      const title = m?.title ?? 'Téléchargement';
      let episode: string | undefined;
      if (s && ep) {
        const sn = String(s.seasonNumber).padStart(2, '0');
        const en = String(ep.episodeNumber).padStart(2, '0');
        episode = `S${sn}E${en}`;
        if (ep.title) episode += ` ${ep.title}`;
      }
      await this.downloadManager.createDownload(ev.mediaFileId, ev.quality, title, episode);
    } catch {
      this.toast.error(this.translate.instant('downloads.error'));
    }
  }
}
