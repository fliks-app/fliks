import { Directive, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { MediaService, type Media, type MediaCastEntry, type MediaCrewEntry, type Season } from '../../core/services/api/media.service';
import { StreamingApiService, type MediaResumeInfo } from '../../core/services/api/streaming-api.service';
import { AuthService } from '../../core/services/auth.service';
import { SpoilerService } from '../../core/services/spoiler.service';
import { TvService } from '../../core/services/tv.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { TrackingModalService } from '../../core/services/tracking-modal.service';
import { DownloadManagerService, episodeLabel, type DownloadTarget } from '../../core/services/download-manager.service';
import { DownloadProgressService } from '../../core/services/download-progress.service';
import { isActive, nothingStartedKey } from '../../core/services/download-status';
import type { MediaActionHandlers } from '../../core/plugin-ui/media-action-registry';
import { hasProviderId } from '../../core/utils/media-identity';
import { KIND_REGISTRY, kindOf } from '../../core/media-kinds';
import { collectScopedLeaves, describeDownload } from '../../shared/utils/download-format';
import { leavingLabel, scopedLeavingLabels } from '../../shared/utils/cleanup.util';
import { DetailHeroComponent, type DetailHeroBadge } from '../../shared/components/detail-hero/detail-hero';
import { DownloadQualityModalComponent } from '../../shared/components/download-quality-modal/download-quality-modal';
import { DownloadDetailModalComponent } from '../../shared/components/download-detail-modal/download-detail-modal';
import { SubtitlesModalComponent } from '../../shared/components/subtitles-modal/subtitles-modal';
import type { TrackingScope } from '../../shared/components/tracking-status-modal/tracking-status-modal';
import { libraryCast } from './components/media-cast/media-cast.component';
import { WatchedController } from './watched-controller';
import { MEDIA_DETAIL_HOST } from './media-detail-host';

type PendingDownload = DownloadTarget & { watched: boolean };

/** What the movie and series pages share: the title's files and playback state, cast, downloads, subtitles and the hero's menu.
 *  A page template must carry the hero, the subtitles modal and the two download modals (`#downloadModal`, `#downloadDetailModal`). */
@Directive()
export abstract class VideoWorkBase {
  readonly media = input.required<Media>();

  protected readonly host = inject(MEDIA_DETAIL_HOST);
  protected readonly mediaService = inject(MediaService);
  protected readonly auth = inject(AuthService);
  protected readonly spoilers = inject(SpoilerService);
  protected readonly translate = inject(TranslateService);
  protected readonly streamingApi = inject(StreamingApiService);
  protected readonly tv = inject(TvService);
  protected readonly toast = inject(ToastService);
  protected readonly confirmation = inject(ConfirmationService);
  protected readonly downloadManager = inject(DownloadManagerService);
  private readonly downloadProgress = inject(DownloadProgressService);
  private readonly trackingModals = inject(TrackingModalService);

  protected readonly kinds = KIND_REGISTRY;
  readonly watched = new WatchedController({ media: () => this.media() }, this.streamingApi);

  protected readonly canManageSubtitles = computed(() => this.auth.hasPermission('subtitles.manage'));
  protected readonly canEditProfiles = computed(() => this.auth.hasPermission('media.edit'));
  protected readonly canDelete = computed(() => this.auth.hasPermission('media.delete'));
  protected readonly isAdmin = computed(() => this.auth.hasPermission('settings.access'));

  /** No metadata-provider id: title, artwork and provider-derived sections all come from the file. */
  protected readonly unidentified = computed(() => !hasProviderId(this.media()));

  protected readonly cast = signal<MediaCastEntry[]>([]);
  protected readonly castMembers = computed(() => libraryCast(this.cast()));
  protected readonly crew = signal<MediaCrewEntry[]>([]);
  protected readonly directors = computed(() =>
    this.crew()
      .filter((c) => c.job?.toLowerCase() === 'director')
      .map((c) => c.person.name),
  );
  protected readonly resumeInfo = signal<MediaResumeInfo | null>(null);

  // ── Files ──
  protected readonly mediaFiles = computed(() => {
    const m = this.media();
    // Series files belong to episodes; hide orphans at the root.
    return kindOf(m.type).hasSeasons ? [] : (m.files ?? []);
  });
  protected readonly headerFiles = computed(() => {
    const m = this.media();
    return kindOf(m.type).hasSeasons ? (m.files ?? []) : this.mediaFiles();
  });
  /** Falls back to the file's own duration when the provider never gave a runtime. */
  protected readonly displayRuntime = computed(() => {
    const m = this.media();
    if (m.runtime) return m.runtime;
    const seconds = this.mediaFiles()[0]?.streamInfo?.durationSeconds;
    return seconds ? Math.round(seconds / 60) : (m.runtime ?? null);
  });
  readonly selectedFileId = signal<number | null>(null);
  protected readonly activeFileId = computed(() => this.selectedFileId() ?? this.mediaFiles()[0]?.id ?? null);
  protected readonly activeFile = computed(() => {
    const id = this.activeFileId();
    return this.mediaFiles().find((f) => f.id === id) ?? null;
  });

  /** Keep the selection pointing at a file that still exists, validated against
   *  every file (a series' selection is an episode file, absent from `mediaFiles`). */
  private readonly autoSelectFileEffect = effect(() => {
    const all = this.media().files ?? [];
    const current = this.selectedFileId();
    if (current != null && all.some((f) => f.id === current)) return;
    this.selectedFileId.set(this.mediaFiles()[0]?.id ?? null);
  });

  // ── Loading ──
  private readonly mediaId = computed(() => this.media().id);
  private readonly identified = computed(() => hasProviderId(this.media()));

  /** Nothing here survives a switch to another title. */
  private readonly resetEffect = effect(() => {
    this.mediaId();
    untracked(() => {
      this.resumeInfo.set(null);
      this.watched.reset();
      this.selectedFileId.set(null);
      this.onTitleChange();
    });
  });

  private readonly loadEffect = effect(() => {
    this.mediaId();
    if (!this.host.fullLoaded()) return;
    untracked(() => {
      void this.loadPlaybackState(this.media());
      this.requestCastAndCrew();
    });
  });

  private requestCastAndCrew(): void {
    const id = this.mediaId();
    this.cast.set([]);
    this.crew.set([]);
    // Provider-derived sections have nothing to fetch for an unidentified title.
    if (!this.identified()) return;
    this.mediaService.getCast(id).then((c) => this.mediaId() === id && this.cast.set(c)).catch(() => {});
    this.mediaService.getCrew(id).then((c) => this.mediaId() === id && this.crew.set(c)).catch(() => {});
    this.loadRelated(id);
  }

  /** Rails a kind adds below the cast. */
  protected loadRelated(_id: number): void {}

  /** What a kind clears when another title replaces this one. */
  protected onTitleChange(): void {}

  /** Cached page back on screen: the playback state is the only thing that moved. */
  private lastReturn = this.host.returns();
  private readonly returnEffect = effect(() => {
    const n = this.host.returns();
    if (n === this.lastReturn) return;
    this.lastReturn = n;
    untracked(() => {
      void this.loadPlaybackState(this.media());
      this.hero()?.reloadPlaybackState();
    });
  });

  /** The `?action=` deep links this page answers: the episode's own tracking and refresh, and subtitles. */
  private readonly pageActions = this.host.registerPageActions({
    subtitles: () => this.openSubtitles(),
    tracking: () => this.openTracking(this.trackingScope()),
    refresh: () => void this.refreshMetadata(),
  });

  /** Resume position, watched episodes and progress from uncacheable /api/playback routes,
   *  kept off the render path and re-run when the page returns on screen. */
  protected async loadPlaybackState(m: Media): Promise<void> {
    this.applyResume(m, await this.streamingApi.getMediaResumeInfo(m.id).catch(() => null));
  }

  /** Pre-select the last-played file if available. */
  protected applyResume(m: Media, resumeInfo: MediaResumeInfo | null): void {
    this.resumeInfo.set(resumeInfo);
    if (resumeInfo?.mediaFileId && (m.files ?? []).some((f) => f.id === resumeInfo.mediaFileId)) {
      this.selectedFileId.set(resumeInfo.mediaFileId);
    }
  }

  // ── Hero, subtitles, tracking ──
  protected readonly hero = viewChild(DetailHeroComponent);
  protected readonly subtitleSection = viewChild(SubtitlesModalComponent);

  protected openSubtitles(): void {
    this.subtitleSection()?.show();
  }

  protected reloadSubtitles(): void {
    void this.subtitleSection()?.loadSubtitles(this.mediaId());
  }

  protected trackingScope(): TrackingScope {
    return { kind: this.media().type };
  }

  protected openTracking(scope: TrackingScope): void {
    this.trackingModals.open(this.mediaId(), scope);
  }

  async deleteFile(fileId: number, deleteOnDisk: boolean): Promise<void> {
    try {
      await this.mediaService.deleteFile(this.mediaId(), fileId, deleteOnDisk);
      // Not a local splice: the server also flips the episode's `hasFile`, which the season tree renders from.
      await this.host.reload();
    } catch {
      // ignore
    }
  }

  protected scopedLeaving(seasons: Season[]): string[] {
    return scopedLeavingLabels(this.translate, seasons);
  }

  protected leavingLabel(deleteAt: string): string {
    return leavingLabel(this.translate, deleteAt);
  }

  // ── The hero's menu ──

  /** The entries the hero cannot handle alone; a kind page narrows or adds to them. */
  protected readonly actions = computed<MediaActionHandlers>(() => ({
    ...this.commonActions(),
    ...this.titleActions(),
  }));

  protected commonActions(): MediaActionHandlers {
    return {
      'media.identify': () => this.host.openIdentify(),
      'media.refresh-metadata': () => void this.refreshMetadata(),
      'media.analyze': () => this.host.openAnalyze(),
      'media.edit-subtitles': () => this.openSubtitles(),
      'media.request': () => this.host.requestFlow.openForMedia(),
      'media.toggle-monitored': () => void this.toggleMonitored(),
    };
  }

  /** The entries that act on the whole title. */
  protected titleActions(): MediaActionHandlers {
    return {
      'media.edit-profiles': () => this.host.openProfiles(),
      'media.edit-library': () => this.host.openLibrary(),
      'media.delete': () => void this.host.deleteMedia(),
      'media.request-deletion': () => this.host.requestFlow.requestDeletion(),
    };
  }

  protected refreshMetadata(): Promise<void> {
    return this.host.refreshMetadata();
  }

  protected toggleMonitored(): Promise<void> {
    return this.host.toggleMonitored();
  }

  // ── Downloads ──

  /** Live download progress for the media on screen (null when not downloading). Fed by `download.progress` SSE + a one-shot seed on load. */
  protected readonly activeDownload = computed(() => this.downloadProgress.progress().get(this.mediaId()) ?? null);

  /** Header download chip: one download shows its own state, several show a count.
   *  Downloads only; the monitored state has its own chip and menu entry. */
  protected downloadBadge(scope: { seasonFilter?: number[]; episodeFilter?: number } = {}): DetailHeroBadge | null {
    const progress = this.activeDownload();
    if (!progress) return null;
    // Non-interactive on TV: a focusable header button would add a second D-pad stop.
    const clickable = !this.tv.isTv();

    const leaves = progress.seasons ? collectScopedLeaves(progress, scope.seasonFilter, scope.episodeFilter) : [];
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
    return { labelKey: d.labelKey, labelParams: null, percent: d.percent, badgeClass: d.badgeClass, clickable, busy: d.busy };
  }

  protected readonly headerBadge = computed(() => this.downloadBadge());

  protected readonly downloadModal = viewChild<DownloadQualityModalComponent>('downloadModal');
  protected readonly downloadDetailModal = viewChild<DownloadDetailModalComponent>('downloadDetailModal');

  /** The file the download button acts on. */
  protected downloadFileId(): number | null {
    return this.activeFileId();
  }

  /** The episode the download button acts on, when there is one. */
  protected downloadFocus(): { season: Season; episode: { id: number; episodeNumber: number; title?: string | null } } | null {
    return null;
  }

  /** Download of the file on screen; a failed one reads as none. */
  protected readonly fileDownload = computed(() => {
    const id = this.downloadFileId();
    const task = id ? this.downloadManager.tasks().find((t) => t.mediaFileId === id && t.status !== 'failed') : undefined;
    return task ?? null;
  });

  protected readonly activeDownloadProgress = computed(() => {
    const t = this.fileDownload();
    return t && isActive(t.status) ? t.progress : null;
  });

  /** Targets chosen from a season, the series or an episode row; consumed by the next quality pick. */
  protected pendingDownloads: PendingDownload[] | null = null;

  protected openBatch(targets: PendingDownload[]): void {
    if (!targets.length) return;
    this.pendingDownloads = targets;
    const unwatched = targets.filter((t) => !t.watched).length;
    void this.downloadModal()?.openBatch(targets[0].mediaFileId!, { all: targets.length, unwatched });
  }

  protected openDownloadModal(): void {
    this.pendingDownloads = null;
    const fileId = this.downloadFileId();
    const task = this.fileDownload();
    if (fileId) this.downloadModal()?.open(fileId, task?.quality ?? null);
  }

  protected openDownloadDetailModal(): void {
    this.downloadDetailModal()?.open();
  }

  protected async onRemoveDownload(): Promise<void> {
    const task = this.fileDownload();
    if (!task) return;
    const active = isActive(task.status);
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant(active ? 'downloads.confirm_cancel' : 'downloads.confirm_delete'),
      confirmLabel: this.translate.instant(active ? 'downloads.cancel_download' : 'common.delete'),
      variant: 'danger',
    });
    if (confirmed) await this.downloadManager.deleteDownload(task);
  }

  protected async onDownload(ev: { mediaFileId: number; quality: string; unwatchedOnly: boolean }): Promise<void> {
    const pending = this.pendingDownloads;
    this.pendingDownloads = null;
    if (pending) {
      const targets = ev.unwatchedOnly ? pending.filter((t) => !t.watched) : pending;
      // Announced up front: the batch creates its downloads one by one, which takes a while.
      const count = targets.filter((t) => !t.mediaFileId || !this.downloadManager.isOnDevice(t.mediaFileId)).length;
      if (count) {
        this.toast.success(
          this.translate.instant(count === 1 ? 'downloads.episodes_queued_one' : 'downloads.episodes_queued_other', { count }),
        );
      }
      const { started, failed, skipped } = await this.downloadManager.createMany(targets, ev.quality);
      if (failed) this.toast.error(this.translate.instant('downloads.error'));
      else if (!started) this.toast.info(this.translate.instant(nothingStartedKey(skipped, targets.length)));
      return;
    }
    try {
      const m = this.media();
      const focus = this.downloadFocus();
      const episode = focus ? episodeLabel(focus.season.seasonNumber, focus.episode.episodeNumber, focus.episode.title) : undefined;
      const prev = this.downloadManager.tasks().find((t) => t.mediaFileId === ev.mediaFileId && t.status !== 'failed');
      if (prev) await this.downloadManager.deleteDownload(prev);
      await this.downloadManager.createDownload(ev.mediaFileId, ev.quality, m.title, episode, {
        mediaId: m.id,
        posterUrl: m.posterUrl,
        type: m.type,
        episodeId: focus?.episode.id,
        seasonNumber: focus?.season.seasonNumber,
        episodeNumber: focus?.episode.episodeNumber,
      });
      this.toast.success(this.translate.instant('downloads.started'));
    } catch {
      this.toast.error(this.translate.instant('downloads.error'));
    }
  }
}
