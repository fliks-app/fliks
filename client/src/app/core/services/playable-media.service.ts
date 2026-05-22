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
  /** Episode thumbnail to use as the eager backdrop instead of the
   *  series fanart when playing an episode. Optional. */
  stillUrl?: string | null;
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
      // Pass fanartUrl + stillUrl via router state so the player can
      // paint the backdrop on its first tick — without it the image
      // only appears after the media API call returns AND the image
      // finishes downloading (~1s+ on cold network), leaving a long
      // black phase. Player prefers `stillUrl` over `fanartUrl` when
      // both are present (episode-accurate backdrop on series).
      this.router.navigate(['/watch', ctx.fileId], {
        queryParams: qp,
        state: {
          fanartUrl: ctx.fanartUrl ?? null,
          stillUrl: ctx.stillUrl ?? null,
        },
      });
    }
  }

  /** Toggle watched status for a media/episode. Returns the new completed state. */
  async toggleWatched(mediaId: number, fileId: number, episodeId?: number): Promise<boolean> {
    const state = await this.streamingApi.toggleWatched(mediaId, fileId, episodeId);
    return state.completed;
  }

  /** Load the watched state for a media/episode. */
  async loadWatchedState(mediaId: number, episodeId?: number): Promise<boolean> {
    try {
      const ps = await this.streamingApi.getPlaybackState(mediaId, episodeId);
      return ps?.completed ?? false;
    } catch {
      return false;
    }
  }
}
