import {
  Component,
  ChangeDetectionStrategy,
  signal,
  computed,
  inject,
  OnInit,
  OnDestroy,
  viewChild,
  ElementRef,
} from '@angular/core';
import { DecimalPipe, NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  DownloadClientsApiService,
  QueueItem,
} from '../../../core/services/api/download-clients-api.service';
import {
  MediaService,
  Media,
  MovieRelease,
} from '../../../core/services/api/media.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';
import { AppResumeService } from '../../../core/services/app-resume.service';
import { Subscription } from 'rxjs';
import {
  LucideRotateCcw,
  LucideLink2,
  LucideEllipsisVertical,
  LucideTriangleAlert,
  LucideDownload,
  LucideSearch,
  LucideTrash2,
  LucideBan,
} from '@lucide/angular';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { DropdownMenuComponent } from '../../../shared/components/dropdown-menu';
import { PaginationComponent } from '../../../shared/components/pagination/pagination';
import { ReleasesModalComponent } from '../../media-detail/components/releases-modal/releases-modal.component';

@Component({
  selector: 'app-activity-queue',
  imports: [TranslateModule, DecimalPipe, NgClass, RouterLink, FormsModule, ResolveUrlPipe, DropdownMenuComponent, PaginationComponent, ReleasesModalComponent, LucideRotateCcw, LucideLink2, LucideEllipsisVertical, LucideTriangleAlert, LucideDownload, LucideSearch, LucideTrash2, LucideBan],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './queue.html',
})
export class ActivityQueueComponent implements OnInit, OnDestroy {
  private readonly downloadApi = inject(DownloadClientsApiService);
  private readonly mediaService = inject(MediaService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly appResume = inject(AppResumeService);

  readonly queue = signal<QueueItem[]>([]);
  readonly queueLoading = signal(true);
  readonly queueError = signal('');
  readonly importing = signal(false);

  // Server-side filtering + pagination. Filters hold the raw status values
  // (the same English strings the backend assigns and the colour/logic
  // conditions below compare against).
  readonly torrentFilter = signal('');
  readonly fliksFilter = signal('');
  readonly search = signal('');
  readonly page = signal(1);
  readonly pageSize = signal(20);
  readonly total = signal(0);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  /** Fixed option lists — the full set of statuses the backend can emit,
   *  so the dropdowns stay stable regardless of the current page. */
  readonly torrentStatusOptions = [
    'Downloading', 'Downloading metadata', 'Seeding', 'Stalled', 'Paused',
    'Queued', 'Checking', 'Allocating', 'Moving', 'Stopped', 'Missing files',
    'Error', 'Unknown',
  ];
  readonly fliksStatusOptions = [
    'Awaiting import', 'Importing', 'Imported', 'Quality not upgraded',
    'Import failed',
  ];

  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.total() / this.pageSize())),
  );
  readonly hasFilter = computed(
    () => !!this.torrentFilter() || !!this.fliksFilter() || !!this.search(),
  );

  /** Current page grouped by add date, newest first (the backend sorts by
   *  added_on desc, so a single pass yields contiguous day groups). */
  readonly groupedQueue = computed(() => {
    const groups: { key: string; label: string; items: QueueItem[] }[] = [];
    for (const item of this.queue()) {
      const key = this.dayKey(item.added_on);
      const last = groups[groups.length - 1];
      if (last && last.key === key) {
        last.items.push(item);
      } else {
        groups.push({ key, label: this.dayLabel(item.added_on), items: [item] });
      }
    }
    return groups;
  });

  // Link torrent modal
  readonly linkDialog = viewChild<ElementRef<HTMLDialogElement>>('linkModal');
  readonly linkItem = signal<QueueItem | null>(null);
  readonly linkSearch = signal('');
  readonly linkResults = signal<Media[]>([]);
  readonly linkSearching = signal(false);
  readonly linkSelectedMediaId = signal<number | null>(null);
  readonly linkSaving = signal(false);

  // Replacement-release modal: searches the indexers for the same target as
  // a queue item, so a stuck torrent can be swapped for another release.
  private readonly replacementModal = viewChild<ReleasesModalComponent>('replacementModal');
  readonly replacementItem = signal<QueueItem | null>(null);
  readonly replacementReleases = signal<MovieRelease[]>([]);
  readonly replacementLoading = signal(false);
  readonly replacementSearched = signal(false);
  readonly replacementError = signal('');
  readonly replacementGrabBusy = signal<string | null>(null);
  readonly replacementGrabState = signal<Map<string, 'ok' | 'error'>>(new Map());

  readonly replacementTitle = computed(() => {
    const it = this.replacementItem();
    if (!it) return '';
    const base = it.mediaTitle ?? it.name;
    if (it.episodeNumber != null) {
      const s = String(it.seasonNumber ?? 0).padStart(2, '0');
      const e = String(it.episodeNumber).padStart(2, '0');
      return `${base} — S${s}E${e}`;
    }
    if (it.seasonNumber != null) {
      return `${base} — ${this.translate.instant('activity.season_pack', { season: it.seasonNumber })}`;
    }
    return base;
  });

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private resumeSub?: Subscription;

  ngOnInit() {
    this.refreshQueue();
    this.intervalId = setInterval(() => this.refreshQueue(), 10_000);
    // Native app-resume: pull the queue immediately on foreground rather than
    // waiting up to 10s for the next interval tick (timers are throttled while
    // backgrounded). This page has no route reuse, so it's always the visible
    // one when alive.
    this.resumeSub = this.appResume.resume$.subscribe(() => this.refreshQueue());
  }

  ngOnDestroy() {
    if (this.intervalId !== null) clearInterval(this.intervalId);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.resumeSub?.unsubscribe();
  }

  /** Local YYYY-MM-DD key for grouping (added_on is unix seconds). */
  private dayKey(addedOn: number): string {
    if (!addedOn) return 'unknown';
    const d = new Date(addedOn * 1000);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  /** Human label for a day group: today / yesterday / localized date. */
  private dayLabel(addedOn: number): string {
    if (!addedOn) return '—';
    const d = new Date(addedOn * 1000);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const sameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
    if (sameDay(d, today)) return this.translate.instant('activity.today');
    if (sameDay(d, yesterday)) return this.translate.instant('activity.yesterday');
    return d.toLocaleDateString(this.translate.currentLang || undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  get hasImportable(): boolean {
    return this.queue().some(
      (q) => q.status === 'Awaiting import' || q.status === 'Import failed',
    );
  }

  async triggerImport() {
    this.importing.set(true);
    try {
      await this.downloadApi.triggerImport();
      setTimeout(() => this.refreshQueue(), 3000);
    } catch { /* ignore */ } finally {
      this.importing.set(false);
    }
  }

  async reimportAndTrigger(item: QueueItem) {
    this.importing.set(true);
    try {
      await this.downloadApi.reimport(item.hash);
      await this.downloadApi.triggerImport();
      this.toast.info(this.translate.instant('activity.import_started'));
      setTimeout(() => this.refreshQueue(), 3000);
    } catch { /* ignore */ } finally {
      this.importing.set(false);
    }
  }

  async removeTorrent(item: QueueItem, deleteFiles: boolean) {
    const msg = deleteFiles
      ? this.translate.instant('activity.confirm_delete_with_files')
      : this.translate.instant('activity.confirm_delete');
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: msg, variant: 'danger' })) return;
    try {
      await this.downloadApi.removeTorrent(item.hash, item.clientId, deleteFiles);
      this.queue.update((q) => q.filter((i) => i.hash !== item.hash));
    } catch { /* ignore */ }
  }

  async blockTorrent(item: QueueItem) {
    if (!await this.confirmation.confirm({
      title: this.translate.instant('activity.block_torrent'),
      message: this.translate.instant('activity.confirm_block'),
      variant: 'danger',
    })) return;
    try {
      await this.downloadApi.blockTorrent(item.hash, item.clientId);
      this.queue.update((q) => q.filter((i) => i.hash !== item.hash));
      this.toast.info(this.translate.instant('activity.block_started'));
    } catch { /* ignore */ }
  }

  openLinkModal(item: QueueItem) {
    this.linkItem.set(item);
    this.linkSearch.set(item.name.replace(/\./g, ' ').replace(/\[.*?\]/g, '').trim());
    this.linkResults.set([]);
    this.linkSelectedMediaId.set(null);
    this.linkDialog()?.nativeElement.showModal();
    this.searchMediaForLink();
  }

  async searchMediaForLink() {
    const q = this.linkSearch().trim();
    if (!q) return;
    this.linkSearching.set(true);
    try {
      const res = await this.mediaService.getAll({ q, limit: 10 });
      this.linkResults.set(res.data);
    } finally {
      this.linkSearching.set(false);
    }
  }

  async confirmLink() {
    const item = this.linkItem();
    const mediaId = this.linkSelectedMediaId();
    if (!item || !mediaId) return;
    this.linkSaving.set(true);
    try {
      await this.mediaService.linkTorrent(mediaId, item.hash);
      this.linkDialog()?.nativeElement.close();
      await this.refreshQueue();
    } finally {
      this.linkSaving.set(false);
    }
  }

  async searchReplacement(item: QueueItem) {
    if (!item.mediaId) return;
    // Full reset so reopening for another item never shows stale results.
    this.replacementItem.set(item);
    this.replacementReleases.set([]);
    this.replacementSearched.set(false);
    this.replacementError.set('');
    this.replacementGrabBusy.set(null);
    this.replacementGrabState.set(new Map());
    this.replacementLoading.set(true);
    this.replacementModal()?.showModal();
    try {
      const rows = await this.loadReplacementReleases(item);
      this.replacementReleases.set(rows);
      this.replacementSearched.set(true);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.replacementSearched.set(true);
      this.replacementError.set(
        httpErr.error?.message ??
          this.translate.instant('media_detail.releases_error'),
      );
    } finally {
      this.replacementLoading.set(false);
    }
  }

  private loadReplacementReleases(item: QueueItem): Promise<MovieRelease[]> {
    const mediaId = item.mediaId!;
    if (item.mediaType === 'series') {
      if (item.episodeId != null) {
        return this.mediaService.getEpisodeReleases(mediaId, item.episodeId);
      }
      if (item.seasonId != null) {
        return this.mediaService.getSeasonReleases(mediaId, item.seasonId);
      }
      // No episode/season scope resolved — searching the whole series could
      // grab the wrong thing, so surface the error instead of guessing.
      return Promise.reject({
        error: { message: this.translate.instant('activity.search_no_target') },
      });
    }
    return this.mediaService.getMovieReleases(mediaId);
  }

  async grabReplacement(r: MovieRelease, index: number) {
    const item = this.replacementItem();
    if (!item?.mediaId) return;
    const key = `rep-${index}`;
    this.replacementGrabBusy.set(key);
    try {
      await this.grabReplacementTarget(item, r);
      this.replacementGrabState.update((s) => new Map(s).set(key, 'ok'));
      // The replacement is grabbed — retire the stuck torrent without asking:
      // blockTorrent removes it (files included), blocklists its release and
      // marks the history failed. The scoped re-search it queues server-side
      // no-ops since the target is no longer missing.
      try {
        await this.downloadApi.blockTorrent(item.hash, item.clientId);
        this.queue.update((q) => q.filter((i) => i.hash !== item.hash));
        this.toast.success(this.translate.instant('activity.replacement_grabbed'));
      } catch {
        this.toast.warning(
          this.translate.instant('activity.replacement_grabbed_block_failed'),
        );
      }
      await this.refreshQueue();
    } catch {
      this.replacementGrabState.update((s) => new Map(s).set(key, 'error'));
    } finally {
      this.replacementGrabBusy.set(null);
    }
  }

  private grabReplacementTarget(item: QueueItem, r: MovieRelease): Promise<unknown> {
    const mediaId = item.mediaId!;
    const body = {
      downloadUrl: r.downloadUrl,
      sourceTitle: r.title,
      indexerId: r.indexerId,
    };
    if (item.mediaType === 'series') {
      if (item.episodeId != null) {
        return this.mediaService.grabEpisode(mediaId, item.episodeId, body);
      }
      if (item.seasonId != null) {
        return this.mediaService.grabSeason(mediaId, item.seasonId, body);
      }
      return Promise.reject(new Error('no replacement target'));
    }
    return this.mediaService.grabMovie(mediaId, body);
  }

  showStallStrikes(item: QueueItem): boolean {
    // 1 strike is just the baseline snapshot — only surface the badge once
    // at least one full interval has passed without progress.
    return (
      item.stalledStrikes != null &&
      item.stalledStrikesRequired != null &&
      item.stalledStrikes >= 2
    );
  }

  /** Warning until the last check before cleanup, then error. */
  stallStrikeClass(item: QueueItem): string {
    const current = item.stalledStrikes ?? 0;
    const required = item.stalledStrikesRequired ?? 0;
    return current >= required - 1 ? 'badge-error' : 'badge-warning';
  }

  async refreshQueue(): Promise<void> {
    try {
      const res = await this.downloadApi.getQueue({
        page: this.page(),
        pageSize: this.pageSize(),
        torrentStatus: this.torrentFilter() || undefined,
        fliksStatus: this.fliksFilter() || undefined,
        search: this.search().trim() || undefined,
      });
      // A filter/deletion may have shrunk the result past the current page —
      // snap back and refetch so we never show an empty page mid-list.
      if (res.items.length === 0 && res.total > 0 && res.page > 1) {
        this.page.set(1);
        return this.refreshQueue();
      }
      this.queue.set(res.items);
      this.total.set(res.total);
      this.pageSize.set(res.pageSize);
      this.queueError.set('');
    } catch {
      this.queueError.set(this.translate.instant('activity.queue_error'));
    } finally {
      this.queueLoading.set(false);
    }
  }

  setTorrentFilter(value: string) {
    this.torrentFilter.set(value);
    this.page.set(1);
    void this.refreshQueue();
  }

  setFliksFilter(value: string) {
    this.fliksFilter.set(value);
    this.page.set(1);
    void this.refreshQueue();
  }

  onSearch(value: string) {
    this.search.set(value);
    this.page.set(1);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.refreshQueue(), 300);
  }

  goToPage(p: number) {
    const clamped = Math.min(Math.max(p, 1), this.totalPages());
    if (clamped === this.page()) return;
    this.page.set(clamped);
    void this.refreshQueue();
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  formatSpeed(bytesPerSec: number): string {
    return `${this.formatBytes(bytesPerSec)}/s`;
  }

  formatEta(seconds: number): string {
    if (seconds <= 0 || !isFinite(seconds)) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  appStateClass(status: string): string {
    switch (status) {
      case 'Awaiting import':
      case 'Importing': return 'badge-warning';
      case 'Imported': return 'badge-success';
      case 'Quality not upgraded': return 'badge-warning';
      case 'Import failed': return 'badge-error';
      default: return 'badge-ghost';
    }
  }

  /** Translate a raw status value for display. Backend statuses are fixed
   *  English strings; this maps them to `activity.<prefix>_<slug>` keys and
   *  falls back to the raw value when no translation exists. */
  private statusLabel(prefix: 'tstatus' | 'fstatus', raw: string): string {
    if (!raw) return '';
    const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const key = `activity.${prefix}_${slug}`;
    const translated = this.translate.instant(key);
    return translated === key ? raw : translated;
  }

  torrentStatusLabel(status: string): string {
    return this.statusLabel('tstatus', status);
  }

  fliksStatusLabel(status: string): string {
    return this.statusLabel('fstatus', status);
  }
}
