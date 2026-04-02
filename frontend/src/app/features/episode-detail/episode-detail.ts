import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Media, MediaService, Season, Episode } from '../../core/services/api/media.service';
import { SubtitlesApiService, SubtitleFileRow } from '../../core/services/api/subtitles-api.service';
import { MediaDetailSubtitlesComponent } from '../media-detail/components/media-detail-subtitles/media-detail-subtitles.component';
import { MediaDetailSubtitleSearchModalComponent } from '../media-detail/components/media-detail-subtitle-search-modal/media-detail-subtitle-search-modal.component';
import { ReleasesModalComponent } from '../media-detail/components/releases-modal/releases-modal.component';
import { MediaDetailFilesComponent } from '../media-detail/components/media-detail-files/media-detail-files.component';
import {
  displayMediaFilePath,
  filesForEpisode,
  formatMediaDetailBytes,
  subtitlesForEpisode,
} from '../media-detail/media-detail.utils';
import type { MediaFileRow } from '../media-detail/media-detail.utils';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-episode-detail',
  imports: [
    RouterLink,
    TranslateModule,
    MediaDetailSubtitlesComponent,
    MediaDetailSubtitleSearchModalComponent,
    ReleasesModalComponent,
    MediaDetailFilesComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './episode-detail.html',
})
export class EpisodeDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly mediaService = inject(MediaService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

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

  readonly isAdmin = computed(() => this.auth.hasPermission('settings.access'));
  readonly canGrab = computed(() => this.auth.hasPermission('media.grab'));

  readonly episodeFiles = computed<MediaFileRow[]>(() => {
    const m = this.media();
    const ep = this.episode();
    if (!m?.files || !ep) return [];
    return filesForEpisode(m.files, ep.id);
  });

  readonly episodeSubtitles = computed<SubtitleFileRow[]>(() => {
    const m = this.media();
    const ep = this.episode();
    if (!m || !ep) return [];
    return subtitlesForEpisode(this.subtitles(), ep.id, m.files);
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
    this.subtitleActionBusy.set(true);
    try {
      await this.subtitlesApi.sync(m.id, event.subtitleId, event.options);
    } finally {
      this.subtitleActionBusy.set(false);
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
    const file = this.episodeFiles()[0];
    if (!file) return;
    this.subtitleActionBusy.set(true);
    try {
      await this.subtitlesApi.autoDownload(m.id, {
        mediaFileId: file.id,
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
    const file = this.episodeFiles()[0];
    if (!file) return;
    this.subtitleActionBusy.set(true);
    try {
      await this.subtitlesApi.download(m.id, {
        searchResult: result,
        mediaFileId: file.id,
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

  fileDiskPath(relativePath: string): string {
    return displayMediaFilePath(this.media()?.path, relativePath);
  }

  pad(n: number): string {
    return String(n).padStart(2, '0');
  }

}
