import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { MediaService, Media } from '../../core/services/api/media.service';
import { StreamingApiService, ContinueWatchingItem } from '../../core/services/api/streaming-api.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { CastService } from '../../core/services/cast.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { LucideIconComponent } from '../../shared/components/lucide-icon';

@Component({
  selector: 'app-home',
  imports: [
    RouterLink, TranslateModule,
    MediaCardComponent,
    HorizontalScrollerComponent,
    LucideIconComponent,
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
  private readonly librariesApi = inject(LibrariesApiService);

  readonly loading = signal(true);
  readonly libraries = signal<LibrarySummary[]>([]);
  readonly continueWatching = signal<ContinueWatchingItem[]>([]);
  readonly recentMedia = signal<Media[]>([]);

  libraryUrl(lib: LibrarySummary): string {
    return `/libraries/${encodeURIComponent(lib.name)}`;
  }

  /** CSS color for library card. DaisyUI 5 names → var(--color-<name>). */
  libraryColor(lib: LibrarySummary): string {
    const c = lib.color || 'primary';
    const daisyColors = ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error'];
    if (daisyColors.includes(c)) return `var(--color-${c})`;
    return c;
  }

  async ngOnInit() {
    try {
      const [libs, cw, recent] = await Promise.all([
        this.librariesApi.listMine().catch(() => []),
        this.streamingApi.getContinueWatching().catch(() => []),
        this.mediaService.getAll({ sortBy: 'createdAt', sortOrder: 'DESC', limit: 20, excludeWatched: true, missing: false }),
      ]);
      this.libraries.set(libs);
      this.continueWatching.set(cw);
      this.recentMedia.set(recent.data);
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
        fanartUrl: item.fanartUrl ?? item.posterUrl,
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
