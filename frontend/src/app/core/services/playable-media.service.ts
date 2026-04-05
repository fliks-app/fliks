import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { CastService } from './cast.service';
import { CastPlayerService } from './cast-player.service';
import { StreamingApiService } from './api/streaming-api.service';

export interface PlayContext {
  fileId: number;
  mediaId: number;
  episodeId?: number;
  title: string;
  episodeTitle?: string;
  fanartUrl?: string | null;
  streamInfo?: any;
}

/**
 * Shared logic for media detail pages (movie + episode):
 * play, toggleWatched, loadWatchedState, Cast integration.
 */
@Injectable({ providedIn: 'root' })
export class PlayableMediaService {
  private readonly router = inject(Router);
  readonly castService = inject(CastService);
  private readonly castPlayer = inject(CastPlayerService);
  private readonly streamingApi = inject(StreamingApiService);

  /** Play a media file — Cast if connected, otherwise navigate to player. */
  async play(ctx: PlayContext, fromStart: boolean) {
    if (this.castService.isConnected()) {
      await this.castPlayer.quickStart({
        mediaFileId: ctx.fileId,
        mediaId: ctx.mediaId,
        episodeId: ctx.episodeId,
        title: ctx.title,
        episodeTitle: ctx.episodeTitle,
        fanartUrl: ctx.fanartUrl ?? null,
        streamInfo: ctx.streamInfo,
        startTime: fromStart ? 0 : undefined,
      });
      this.castPlayer.expanded.set(true);
    } else {
      const qp: any = { mediaId: ctx.mediaId };
      if (ctx.episodeId) qp.episodeId = ctx.episodeId;
      if (fromStart) qp.t = 0;
      this.router.navigate(['/watch', ctx.fileId], { queryParams: qp });
    }
  }

  /** Toggle watched status for a media file. Returns the new completed state. */
  async toggleWatched(fileId: number, mediaId: number, episodeId?: number): Promise<boolean> {
    const state = await this.streamingApi.toggleWatched(fileId, mediaId, episodeId);
    return state.completed;
  }

  /** Load the watched state for a media file. */
  async loadWatchedState(fileId: number): Promise<boolean> {
    try {
      const ps = await this.streamingApi.getPlaybackState(fileId);
      return ps?.completed ?? false;
    } catch {
      return false;
    }
  }
}
