import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LucideFilm, LucideTv } from '@lucide/angular';
import { MediaService, Media } from '../../core/services/api/media.service';
import { StreamingApiService, ContinueWatchingItem } from '../../core/services/api/streaming-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { CastService } from '../../core/services/cast.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';

@Component({
  selector: 'app-home',
  imports: [
    RouterLink, TranslateModule,
    LucideFilm, LucideTv,
    MediaCardComponent,
    HorizontalScrollerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.html',
})
export class HomeComponent implements OnInit {
  private readonly mediaService = inject(MediaService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly router = inject(Router);
  private readonly castService = inject(CastService);
  private readonly castPlayer = inject(CastPlayerService);

  readonly loading = signal(true);
  readonly continueWatching = signal<ContinueWatchingItem[]>([]);
  readonly recentMovies = signal<Media[]>([]);
  readonly recentSeries = signal<Media[]>([]);

  async ngOnInit() {
    try {
      const [cw, movies, series] = await Promise.all([
        this.streamingApi.getContinueWatching().catch(() => []),
        this.mediaService.getAll({ type: 'movie' as any, sortBy: 'createdAt', sortOrder: 'DESC', limit: 20, excludeWatched: true, missing: false }),
        this.mediaService.getAll({ type: 'series' as any, sortBy: 'createdAt', sortOrder: 'DESC', limit: 20, excludeWatched: true, missing: false }),
      ]);
      this.continueWatching.set(cw);
      this.recentMovies.set(movies.data);
      this.recentSeries.set(series.data);
    } catch { /* ignore */ }
    this.loading.set(false);
  }

  async playContinueWatching(item: ContinueWatchingItem) {
    if (this.castService.isConnected()) {
      await this.castPlayer.quickStart({
        mediaFileId: item.mediaFileId,
        mediaId: item.mediaId,
        episodeId: item.episodeId ?? undefined,
        title: item.mediaTitle,
        episodeTitle: item.episodeLabel ?? undefined,
        fanartUrl: item.posterUrl,
      });
      this.castPlayer.expanded.set(true);
    } else {
      const qp: Record<string, number> = { mediaId: item.mediaId };
      if (item.episodeId) qp['episodeId'] = item.episodeId;
      this.router.navigate(['/watch', item.mediaFileId], { queryParams: qp });
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
