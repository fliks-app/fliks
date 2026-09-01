import { Component, ChangeDetectionStrategy, inject, signal, computed, Injector, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideHistory, LucideTrash2, LucidePlay, LucideFilm, LucideTv, LucideCheck, LucideEllipsisVertical } from '@lucide/angular';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { PlaybackState, StreamingApiService, WatchHistoryItem } from '../../core/services/api/streaming-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { keepRouteFresh } from '../../core/services/keep-route-fresh';
import { PaginationComponent } from '../../shared/components/pagination/pagination';
import { DropdownMenuComponent } from '../../shared/components/dropdown-menu';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';

@Component({
  selector: 'app-watch-history',
  imports: [
    CachedSrcDirective,TranslateModule, ResolveUrlPipe, PaginationComponent, DropdownMenuComponent, LucideHistory, LucideTrash2, LucidePlay, LucideFilm, LucideTv, LucideCheck, LucideEllipsisVertical],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './watch-history.html',
})
export class WatchHistoryComponent implements OnInit, OnDestroy {
  private readonly streamingApi = inject(StreamingApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly injector = inject(Injector);
  private readonly translate = inject(TranslateService);
  private static readonly SCROLL_KEY = 'history';
  /** Cached route: revalidate on return and on app-resume so items watched or
   *  deleted elsewhere land, without the spinner coming back. */
  private readonly routeFresh = keepRouteFresh({
    refresh: () => void this.load(true),
    scrollKey: WatchHistoryComponent.SCROLL_KEY,
  });

  readonly loading = signal(true);
  readonly items = signal<WatchHistoryItem[]>([]);
  readonly total = signal(0);
  readonly currentPage = signal(1);
  readonly pageSize = 25;

  readonly totalPages = computed(() => Math.ceil(this.total() / this.pageSize));

  async ngOnInit() {
    this.scrollMemory.activate(WatchHistoryComponent.SCROLL_KEY);
    await this.load();
    this.scrollMemory.restore(WatchHistoryComponent.SCROLL_KEY, this.injector);

  }

  ngOnDestroy() {
    this.scrollMemory.deactivate();
  }

  async load(silent = false) {
    if (!silent) this.loading.set(true);
    try {
      const res = await this.streamingApi.getHistory(this.currentPage(), this.pageSize);
      this.items.set(res.data);
      this.total.set(res.total);
    } catch { /* ignore */ }
    if (!silent) this.loading.set(false);
    queueMicrotask(() => {
      void this.streamingApi
        .getHistory(this.currentPage(), this.pageSize, { force: true })
        .then((fresh) => {
          this.items.set(fresh.data);
          this.total.set(fresh.total);
        })
        .catch(() => { /* keep cached body */ });
    });
  }

  async goToPage(page: number) {
    if (page < 1 || page > this.totalPages()) return;
    this.currentPage.set(page);
    await this.load();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  play(item: WatchHistoryItem) {
    const qp: Record<string, number> = { mediaId: item.mediaId };
    if (item.episodeId) qp['episodeId'] = item.episodeId;
    this.router.navigate(['/watch', item.mediaFileId], { queryParams: qp });
  }

  goToMedia(item: WatchHistoryItem) {
    const base = item.mediaType === 'series' ? '/series' : '/movies';
    this.router.navigate([base, item.mediaId]);
  }

  private patchItemFromPlaybackState(prev: WatchHistoryItem, state: PlaybackState): WatchHistoryItem {
    const duration = state.durationSeconds > 0 ? state.durationSeconds : prev.durationSeconds;
    const progressPercent = state.completed
      ? 100
      : duration > 0
        ? Math.min(100, Math.round((state.positionSeconds / duration) * 100))
        : prev.progressPercent;
    return {
      ...prev,
      completed: state.completed,
      positionSeconds: state.positionSeconds,
      durationSeconds: duration,
      progressPercent,
      lastPlayedAt: state.lastPlayedAt,
    };
  }

  async markWatched(item: WatchHistoryItem) {
    try {
      const state = await this.streamingApi.toggleWatched(
        item.mediaId,
        item.mediaFileId,
        item.episodeId ?? undefined,
      );
      this.items.update(list =>
        list.map(i => (i.id === item.id ? this.patchItemFromPlaybackState(i, state) : i)),
      );
    } catch { /* ignore */ }
  }

  async removeItem(item: WatchHistoryItem) {
    const confirmed = await this.confirmation.confirm({
      title: 'Retirer',
      message: `Retirer "${item.mediaTitle}" de l'historique ?`,
    });
    if (!confirmed) return;
    try {
      await this.streamingApi.deletePlaybackState(item.mediaId, item.episodeId ?? undefined);
      this.items.update(list => list.filter(i => i.id !== item.id));
      this.total.update(t => t - 1);
    } catch { /* ignore */ }
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(this.translate.currentLang || undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
