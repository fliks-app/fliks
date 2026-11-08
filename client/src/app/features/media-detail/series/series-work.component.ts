import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { Episode, Media, Season } from '../../../core/services/api/media.service';
import { LikesApiService } from '../../../core/services/api/likes-api.service';
import { OptimizeModalService } from '../../../core/services/optimize-modal.service';
import { RecommendService } from '../../../core/services/recommend.service';
import { episodeLabel, type DownloadTarget } from '../../../core/services/download-manager.service';
import type { MediaActionHandlers } from '../../../core/plugin-ui/media-action-registry';
import { SeasonLabelPipe } from '../../../core/pipes/season-label.pipe';
import { serverMessage } from '../../../core/utils/server-message';
import { DetailHeroComponent } from '../../../shared/components/detail-hero/detail-hero';
import { DetailSectionComponent } from '../../../shared/components/detail-section/detail-section';
import { DownloadDetailModalComponent } from '../../../shared/components/download-detail-modal/download-detail-modal';
import { DownloadQualityModalComponent } from '../../../shared/components/download-quality-modal/download-quality-modal';
import { HorizontalScrollerComponent } from '../../../shared/components/horizontal-scroller';
import { MediaCardComponent } from '../../../shared/components/media-card/media-card';
import { MediaFileInfoComponent } from '../../../shared/components/media-file-info';
import { MediaInfoExtraComponent } from '../../../shared/components/media-info-extra/media-info-extra';
import { SubtitlesModalComponent } from '../../../shared/components/subtitles-modal/subtitles-modal';
import type { TrackingScope } from '../../../shared/components/tracking-status-modal/tracking-status-modal';
import { centerRailOnCard } from '../../../shared/utils/center-rail';
import { LikeController } from '../../../shared/utils/like-controller';
import { MediaDetailSeasonsComponent } from '../components/media-detail-seasons/media-detail-seasons.component';
import { MediaCastComponent } from '../components/media-cast/media-cast.component';
import { EpisodeViewController } from '../episode-view-controller';
import { filterSeasonEpisodesOnDisk, seasonsVisibleWithDiskFilter } from '../media-detail.utils';
import { VideoWorkBase } from '../video-work';
import type { MediaResumeInfo } from '../../../core/services/api/streaming-api.service';

const LS_EPISODES_HAS_FILE_ONLY = 'fliks.mediaDetail.episodesHasFileOnly';

function readEpisodesHasFileOnlyFromStorage(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(LS_EPISODES_HAS_FILE_ONLY) === '1';
  } catch {
    return false;
  }
}

/** The page of a series, rendered by the media detail shell for the `series` kind: the season tree, or one episode when the route names it. */
@Component({
  selector: 'app-series-work',
  imports: [
    TranslatePipe,
    SeasonLabelPipe,
    DetailHeroComponent,
    DetailSectionComponent,
    DownloadDetailModalComponent,
    DownloadQualityModalComponent,
    HorizontalScrollerComponent,
    MediaCardComponent,
    MediaCastComponent,
    MediaDetailSeasonsComponent,
    MediaFileInfoComponent,
    MediaInfoExtraComponent,
    SubtitlesModalComponent,
  ],
  templateUrl: './series-work.component.html',
  host: { class: 'flex flex-col' },
})
export class SeriesWorkComponent extends VideoWorkBase {
  private readonly route = inject(ActivatedRoute);
  private readonly recommend = inject(RecommendService);
  private readonly optimizeModal = inject(OptimizeModalService);

  /** Signal mirror of paramMap: the page is reused across episode URLs, so a snapshot misses changes. */
  private readonly routeParams = toSignal(this.route.paramMap);

  // ── Episode full-page mode (series/:id/episode/:episodeId) ──

  private readonly episodeParam = computed(() => Number(this.routeParams()?.get('episodeId')) || null);

  /** The route's episode in the loaded tree; null while the media in hand is not this route's series. */
  private readonly resolved = computed<{ season: Season; episode: Episode } | null>(() => {
    const m = this.media();
    const episodeId = this.episodeParam();
    if (!episodeId || m.id !== Number(this.routeParams()?.get('id'))) return null;
    for (const season of m.seasons ?? []) {
      const episode = season.episodes?.find((e) => e.id === episodeId);
      if (episode) return { season, episode };
    }
    return null;
  });

  /** The card's episode, standing in until the season tree lands. */
  private readonly seeded = computed<Episode | null>(() => {
    const seed = this.host.episodeSeed();
    if (!seed || seed.episodeId !== this.episodeParam() || this.media().seasons) return null;
    // `monitored` is bound straight through to the header, and an undefined reads as false: an "unmonitored" flash on every seeded load.
    return { id: seed.episodeId, stillUrl: seed.stillUrl, monitored: true } as unknown as Episode;
  });

  protected readonly focusedSeason = computed(() => this.resolved()?.season ?? null);
  protected readonly focusedEpisode = computed(() => this.resolved()?.episode ?? this.seeded());
  protected readonly episodeMode = computed(() => !!this.focusedEpisode());

  protected readonly like = new LikeController(
    { media: () => this.media(), episodeMode: () => this.episodeMode(), focusedEpisode: () => this.focusedEpisode() },
    inject(LikesApiService),
  );

  protected readonly episodeView = new EpisodeViewController(
    {
      media: () => this.media(),
      focusedEpisode: () => this.focusedEpisode(),
      focusedSeason: () => this.focusedSeason(),
      selectedFileId: () => this.selectedFileId(),
      resumeInfo: () => this.resumeInfo(),
    },
    { spoilers: this.spoilers, translate: this.translate, watchedEpisodeIds: this.watched.episodeIds },
  );

  protected readonly episodeSeedLabel = computed(() => this.host.episodeSeed()?.label ?? null);

  /** An episode that is not in the tree is a page that does not exist. */
  private readonly notFoundEffect = effect(() => {
    const m = this.media();
    if (!this.episodeParam() || !m.seasons || m.id !== Number(this.routeParams()?.get('id'))) return;
    if (!this.resolved()) this.host.notFound.set(true);
  });

  private readonly navTitleEffect = effect(() => {
    const r = this.resolved();
    if (!r) {
      this.host.navTitle.set(null);
      return;
    }
    const sn = String(r.season.seasonNumber).padStart(2, '0');
    const en = String(r.episode.episodeNumber).padStart(2, '0');
    this.host.navTitle.set([this.media().title, `S${sn}:E${en}`, r.episode.title].filter(Boolean).join(' - '));
  });

  /** Anti-spoiler masks for the focused episode's hero, still and synopsis. */
  protected readonly episodeSpoilerImage = computed(() => {
    const watched = this.focusedEpisodeWatched();
    return watched === null ? false : this.spoilers.still(watched);
  });
  protected readonly episodeSpoilerOverview = computed(() => {
    const watched = this.focusedEpisodeWatched();
    return watched === null ? false : this.spoilers.overview(watched);
  });

  /** Watched state of the focused episode, `null` outside episode mode. */
  private readonly focusedEpisodeWatched = computed(() => {
    const ep = this.focusedEpisode();
    return ep ? this.watched.episodeIds().has(ep.id) : null;
  });

  /** Same chip as the series page, narrowed to that episode's own downloads or
   *  the season pack that carries it: a sibling episode's grab stays off it. */
  protected readonly episodeHeaderBadge = computed(() => {
    const ep = this.focusedEpisode();
    const season = this.focusedSeason();
    if (!ep || !season) return null;
    return this.downloadBadge({ seasonFilter: [season.seasonNumber], episodeFilter: ep.episodeNumber });
  });

  /** Centre the "Plus de saison X" rail on the opened episode, catching cards that mount after the block's own centring. */
  private readonly scrollToFocusedEpisodeEffect = effect(() => {
    const active = this.focusedEpisode();
    const season = this.focusedSeason();
    if (!active || this.episodeView.currentSeasonEpisodes().length < 2) return;
    setTimeout(() => centerRailOnCard(`episode-${active.id}`, season ? `season-${season.id}` : undefined), 30);
  });

  // ── Seasons ──

  /** Active season tab, the first season selected after load. */
  protected readonly activeSeasonId = signal<number | null>(null);
  protected readonly seasonBusy = signal<number | null>(null);
  /** Show only episodes with a file on disk (persisted in localStorage). */
  protected readonly episodesHasFileOnly = signal(readEpisodesHasFileOnlyFromStorage());

  /** The first season is picked once the playback state says which one to resume. */
  private playbackLoaded = false;

  protected override onTitleChange(): void {
    this.activeSeasonId.set(null);
    this.playbackLoaded = false;
  }

  /** A tree that changed (library saved, profiles patched, monitoring toggled) may hide the selected season. */
  private readonly keepSeasonVisibleEffect = effect(() => {
    this.media();
    untracked(() => this.playbackLoaded && this.syncActiveSeason(false));
  });

  protected selectSeason(seasonId: number): void {
    this.activeSeasonId.set(seasonId);
    this.persistActiveSeason(seasonId);
  }

  private persistActiveSeason(seasonId: number | null): void {
    const id = this.media().id;
    try {
      if (seasonId != null) sessionStorage.setItem(`fliks.season.${id}`, String(seasonId));
      else sessionStorage.removeItem(`fliks.season.${id}`);
    } catch {
      /* private mode */
    }
  }

  private restoreActiveSeason(): number | null {
    try {
      const v = sessionStorage.getItem(`fliks.season.${this.media().id}`);
      return v ? Number(v) : null;
    } catch {
      return null;
    }
  }

  protected setEpisodesHasFileOnly(value: boolean): void {
    this.episodesHasFileOnly.set(value);
    try {
      localStorage.setItem(LS_EPISODES_HAS_FILE_ONLY, value ? '1' : '0');
    } catch {
      /* private mode / quota */
    }
    this.syncActiveSeason();
  }

  /** Keeps activeSeasonId on a visible season (tabs) when the disk filter is active.
   *  `preferDeepLink` lets the `?season=` of an episode page and the remembered tab win over a season that is still visible. */
  private syncActiveSeason(preferDeepLink = true): void {
    const m = this.media();
    if (!m.seasons?.length) return;
    const visible = seasonsVisibleWithDiskFilter(m, this.episodesHasFileOnly());
    if (!visible.length) {
      this.activeSeasonId.set(null);
      return;
    }
    const cur = this.activeSeasonId();
    const curVisible = cur != null && visible.some((s) => s.id === cur);
    if (!preferDeepLink && curVisible) return;

    const qpSeason = Number(this.route.snapshot.queryParamMap.get('season'));
    const match = qpSeason ? visible.find((s) => s.seasonNumber === qpSeason) : undefined;
    if (match) {
      this.activeSeasonId.set(match.id);
      this.persistActiveSeason(match.id);
      return;
    }

    // Restore from sessionStorage (browser back button)
    const stored = this.restoreActiveSeason();
    if (stored != null && visible.some((s) => s.id === stored)) {
      this.activeSeasonId.set(stored);
      return;
    }
    if (!curVisible) this.activeSeasonId.set(visible[0].id);
  }

  protected filteredSeasonEpisodes(season: Season): Episode[] {
    return filterSeasonEpisodesOnDisk(season, this.episodesHasFileOnly());
  }

  protected activeSeason(m: Media): Season | null {
    const id = this.activeSeasonId();
    if (!m.seasons?.length || id == null) return null;
    return m.seasons.find((s) => s.id === id) ?? null;
  }

  protected async toggleSeasonMonitored(season: Season): Promise<void> {
    if (!this.isAdmin()) return;
    this.seasonBusy.set(season.id);
    try {
      const updated = await this.mediaService.updateSeasonMonitored(season.id, !season.monitored);
      const m = this.media();
      if (!m.seasons) return;
      const nextSeasons = m.seasons.map((s) =>
        s.id === updated.id
          ? { ...s, monitored: updated.monitored, episodes: s.episodes.map((e) => ({ ...e, monitored: updated.monitored })) }
          : s,
      );
      this.host.media.set({ ...m, seasons: nextSeasons });
      this.syncActiveSeason();
    } finally {
      this.seasonBusy.set(null);
    }
  }

  protected optimizeSeason(season: Season): void {
    const m = this.media();
    this.optimizeModal.open({
      title: `${m.title} - ${this.translate.instant('media_detail.season_number', { number: season.seasonNumber })}`,
      mediaIds: [m.id],
      episodeIds: season.episodes.filter((e) => e.hasFile).map((e) => e.id),
    });
  }

  protected recommendSeason(seasonId: number): void {
    this.recommend.open({ mediaId: this.media().id, seasonId });
  }

  // ── Playback state ──

  protected override async loadPlaybackState(m: Media): Promise<void> {
    const [resumeInfo, watchedIds, progress] = await Promise.all([
      this.streamingApi.getMediaResumeInfo(m.id).catch(() => null),
      this.streamingApi.getWatchedEpisodeIds(m.id).catch(() => [] as number[]),
      this.streamingApi.getEpisodeProgress(m.id).catch(() => ({}) as Record<number, number>),
    ]);
    this.playbackLoaded = true;
    this.applyResume(m, resumeInfo);
    const watchedSet = new Set(watchedIds);
    this.watched.episodeIds.set(watchedSet);
    this.watched.episodeProgress.set(progress);

    if (!m.seasons?.length) {
      this.activeSeasonId.set(null);
      return;
    }
    // Preselect the season of the in-progress episode (resumeInfo), else of the first unwatched
    // episode with a file (covers between-episodes, where resumeInfo is null).
    const target = this.resumeSeasonId(m, resumeInfo, watchedSet);
    if (target != null) {
      this.activeSeasonId.set(target);
      this.persistActiveSeason(target);
    } else {
      this.syncActiveSeason();
    }
  }

  private resumeSeasonId(m: Media, resumeInfo: MediaResumeInfo | null, watched: Set<number>): number | null {
    const seasons = m.seasons ?? [];
    const resumed = resumeInfo?.episodeId
      ? seasons.find((s) => s.episodes?.some((e) => e.id === resumeInfo.episodeId))?.id
      : undefined;
    return resumed ?? seasons.find((s) => s.episodes?.some((e) => e.hasFile && !watched.has(e.id)))?.id ?? null;
  }

  // ── Hero menu: an episode takes the entries of an item, not of the whole title ──

  protected override trackingScope(): TrackingScope {
    const ep = this.focusedEpisode();
    return ep ? { kind: 'episode', episodeId: ep.id } : super.trackingScope();
  }

  protected override titleActions(): MediaActionHandlers {
    if (this.episodeMode()) return {};
    return { ...super.titleActions(), 'media.download-series': () => this.downloadSeries() };
  }

  protected override async refreshMetadata(): Promise<void> {
    const ep = this.focusedEpisode();
    if (!ep) return super.refreshMetadata();
    try {
      await this.mediaService.refreshEpisodeMetadata(this.media().id, ep.id);
      this.toast.success(this.translate.instant('media_detail.refresh_launched'));
    } catch (err: unknown) {
      this.toast.error(serverMessage(err, this.translate, 'media_detail.refresh_error'));
    }
  }

  protected override async toggleMonitored(): Promise<void> {
    const ep = this.focusedEpisode();
    if (!ep) return super.toggleMonitored();
    const m = this.media();
    const monitored = !ep.monitored;
    this.episodeMonitoredLoading.set(true);
    try {
      await this.mediaService.updateEpisodeMonitored(ep.id, monitored);
      this.host.media.set({
        ...m,
        seasons: m.seasons?.map((s) => ({ ...s, episodes: s.episodes.map((e) => (e.id === ep.id ? { ...e, monitored } : e)) })),
      });
    } finally {
      this.episodeMonitoredLoading.set(false);
    }
  }

  protected readonly episodeMonitoredLoading = signal(false);

  // ── Downloads ──

  protected override downloadFileId(): number | null {
    return this.episodeMode() ? this.episodeView.episodeActiveFileId() : this.activeFileId();
  }

  protected override downloadFocus() {
    const season = this.focusedSeason();
    const episode = this.focusedEpisode();
    return season && episode ? { season, episode } : null;
  }

  private downloadTargets(seasons: Season[]): (DownloadTarget & { watched: boolean })[] {
    const m = this.media();
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

  protected downloadSeason(season: Season): void {
    this.openBatch(this.downloadTargets([season]));
  }

  /** Episodes picked by hand: never filtered by watched state. */
  protected downloadSeasons(seasons: Season[]): void {
    this.openBatch(this.downloadTargets(seasons).map((t) => ({ ...t, watched: false })));
  }

  protected downloadSeries(): void {
    this.openBatch(this.downloadTargets((this.media().seasons ?? []).filter((s) => s.seasonNumber > 0)));
  }

  protected downloadEpisode(season: Season, episode: Episode): void {
    const [target] = this.downloadTargets([{ ...season, episodes: [episode] }]);
    if (!target) return;
    this.pendingDownloads = [{ ...target, watched: false }];
    void this.downloadModal()?.open(target.mediaFileId!);
  }

}
