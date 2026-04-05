import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LucideFilm, LucideTv } from '@lucide/angular';
import { MediaService, Media } from '../../core/services/api/media.service';
import { StreamingApiService, ContinueWatchingItem } from '../../core/services/api/streaming-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { MediaPosterCardComponent } from '../../shared/components/media-poster-card';
import { ContinueWatchingCardComponent } from '../../shared/components/continue-watching-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';

@Component({
  selector: 'app-home',
  imports: [
    RouterLink, TranslateModule,
    LucideFilm, LucideTv,
    MediaPosterCardComponent, ContinueWatchingCardComponent,
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

  async ngOnInit() {
    try {
      const [cw, movies, series] = await Promise.all([
        this.streamingApi.getContinueWatching().catch(() => []),
        this.mediaService.getAll({ type: 'movie' as any, sortBy: 'createdAt', sortOrder: 'DESC', limit: 20, excludeWatched: true }),
        this.mediaService.getAll({ type: 'series' as any, sortBy: 'createdAt', sortOrder: 'DESC', limit: 20, excludeWatched: true }),
      ]);
      this.continueWatching.set(cw);
      this.recentMovies.set(movies.data);
      this.recentSeries.set(series.data);
    } catch { /* ignore */ }
    this.loading.set(false);
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
