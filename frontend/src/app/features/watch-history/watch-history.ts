import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LucideHistory, LucideTrash2, LucidePlay, LucideFilm, LucideTv, LucideCheck } from '@lucide/angular';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { PlaybackState, StreamingApiService, WatchHistoryItem } from '../../core/services/api/streaming-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';

@Component({
  selector: 'app-watch-history',
  imports: [TranslateModule, ResolveUrlPipe, LucideHistory, LucideTrash2, LucidePlay, LucideFilm, LucideTv, LucideCheck],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './watch-history.html',
})
export class WatchHistoryComponent implements OnInit {
  private readonly streamingApi = inject(StreamingApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly items = signal<WatchHistoryItem[]>([]);
  readonly total = signal(0);
  readonly currentPage = signal(1);
  readonly pageSize = 25;

  readonly totalPages = computed(() => Math.ceil(this.total() / this.pageSize));

  /** Visible page numbers (max 7, centered around current page) */
  readonly visiblePages = computed(() => {
    const total = this.totalPages();
    const current = this.currentPage();
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const start = Math.max(1, Math.min(current - 3, total - 6));
    return Array.from({ length: 7 }, (_, i) => start + i);
  });

  async ngOnInit() {
    await this.load();
  }

  async load() {
    this.loading.set(true);
    try {
      const res = await this.streamingApi.getHistory(this.currentPage(), this.pageSize);
      this.items.set(res.data);
      this.total.set(res.total);
    } catch { /* ignore */ }
    this.loading.set(false);
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
        item.mediaFileId,
        item.mediaId,
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
      await this.streamingApi.deletePlaybackState(item.mediaFileId);
      this.items.update(list => list.filter(i => i.id !== item.id));
      this.total.update(t => t - 1);
    } catch { /* ignore */ }
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
