import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LucideFilm, LucideTv } from '@lucide/angular';
import { MediaService, Media } from '../../core/services/api/media.service';
import { StreamingApiService, ContinueWatchingItem } from '../../core/services/api/streaming-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { MediaCardComponent } from '../../shared/components/media-card';
import { ContinueWatchingCardComponent } from '../../shared/components/continue-watching-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';

@Component({
  selector: 'app-home',
  imports: [
    RouterLink, TranslateModule,
    LucideFilm, LucideTv,
    MediaCardComponent, ContinueWatchingCardComponent,
    HorizontalScrollerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.html',
})
export class HomeComponent implements OnInit {
  private readonly mediaService = inject(MediaService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly confirmation = inject(ConfirmationService);

  readonly loading = signal(true);
  readonly continueWatching = signal<ContinueWatchingItem[]>([]);
  readonly recentMovies = signal<Media[]>([]);
  readonly recentSeries = signal<Media[]>([]);
  readonly watchedIds = signal<Set<number>>(new Set());

  async ngOnInit() {
    try {
      const [cw, watchedIds, movies, series] = await Promise.all([
        this.streamingApi.getContinueWatching().catch(() => []),
        this.streamingApi.getWatchedMediaIds().catch(() => [] as number[]),
        this.mediaService.getAll({ type: 'movie' as any, sortBy: 'createdAt', sortOrder: 'DESC', limit: 20, excludeWatched: true, missing: false }),
        this.mediaService.getAll({ type: 'series' as any, sortBy: 'createdAt', sortOrder: 'DESC', limit: 20, excludeWatched: true, missing: false }),
      ]);
      this.continueWatching.set(cw);
      this.watchedIds.set(new Set(watchedIds));
      this.recentMovies.set(movies.data);
      this.recentSeries.set(series.data);
    } catch { /* ignore */ }
    this.loading.set(false);
  }

  async refreshWatchedIds() {
    try {
      const ids = await this.streamingApi.getWatchedMediaIds();
      this.watchedIds.set(new Set(ids));
    } catch {
      /* ignore */
    }
  }

  async removeContinueWatching(item: ContinueWatchingItem) {
    const confirmed = await this.confirmation.confirm({
      title: 'Retirer',
      message: `Retirer "${item.mediaTitle}" de la liste ?`,
    });
    if (!confirmed) return;
    try {
      await this.streamingApi.hideFromContinueWatching(item.mediaId);
      this.continueWatching.update(list => list.filter(i => i.mediaId !== item.mediaId));
    } catch { /* ignore */ }
  }
}
