import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { CastService } from './cast.service';
import { CastPlayerService } from './cast-player.service';
import { MediaService } from './api/media.service';
import { ContinueWatchingItem, StreamingApiService } from './api/streaming-api.service';
import { PlaybackQueueService, QueueItem } from './playback-queue.service';
import { RemoteService } from './remote.service';
import { resolvePlayableFile } from '../../shared/utils/media-play.util';
import { remoteOverlayOpen } from './remote-playback-target';

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
  /** Where the caller knows playback stopped. Only a caller that read it from a
   *  list has it; a detail page leaves the player to resolve its own. */
  positionSeconds?: number;
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
  private readonly mediaService = inject(MediaService);
  private readonly queue = inject(PlaybackQueueService);
  private readonly remote = inject(RemoteService);

  /** Play a media file: on a selected remote target, else Cast if connected,
   *  else navigate to the local player. */
  /** Resume a continue-watching row where the viewer left off. */
  resume(item: ContinueWatchingItem): Promise<void> {
    return this.play(
      {
        fileId: item.mediaFileId,
        mediaId: item.mediaId,
        positionSeconds: item.positionSeconds,
        episodeId: item.episodeId ?? undefined,
        title: item.mediaTitle,
        episodeTitle: item.episodeLabel ?? undefined,
        fanartUrl: item.fanartUrl ?? item.posterUrl ?? null,
        stillUrl: item.stillUrl ?? null,
      },
      false,
    );
  }

  async play(ctx: PlayContext, fromStart: boolean) {
    // A standalone play is never part of a queue — drop any playlist queue so
    // the player doesn't inherit stale "up next" context from a prior session.
    this.queue.clear();
    const targetId = this.remote.selectedTargetId();
    if (targetId) {
      // `send` itself handles an offline target (toast + no local fallback) -
      // never silently demote to Cast/local here.
      remoteOverlayOpen.set(true);
      void this.remote.send(targetId, {
        action: 'load',
        mediaId: ctx.mediaId,
        mediaFileId: ctx.fileId,
        episodeId: ctx.episodeId,
        // The launcher's own position, not the target's: a remote launch counts
        // for whoever started it, so the target's account may have none at all
        // and would restart the title from the beginning.
        positionSeconds: fromStart ? 0 : ctx.positionSeconds,
      });
      return;
    }
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
      // Warm the stale-while-revalidate cache for the media-detail page
      // the user will land on when they back out of the player. The
      // detail's `getOne` / cast / crew responses get stored under
      // `/api/media/<id>*` keys in `fliks-api-cache` (60 min TTL), so the
      // back-navigation renders instantly instead of spinning on a cold
      // network round-trip.
      void this.mediaService.getOne(ctx.mediaId).catch(() => {});
      void this.mediaService.getCast(ctx.mediaId).catch(() => {});
      void this.mediaService.getCrew(ctx.mediaId).catch(() => {});
    }
  }

  /**
   * Start playback of a playlist: registers the ordered queue, resolves the
   * launched item's file and opens the player (or Cast) on it. Subsequent items
   * are advanced by the player as each one finishes (when `autoplay`). Returns
   * false when the launched item has no playable file (caller surfaces the UX).
   */
  async playFromPlaylist(
    playlistId: number,
    items: QueueItem[],
    startIndex: number,
    autoplay: boolean,
  ): Promise<boolean> {
    // Scan forward from the requested start for the first item with an available
    // file, skipping any that aren't playable (e.g. not downloaded yet).
    let index = Math.max(0, startIndex);
    let file: ReturnType<typeof resolvePlayableFile> = null;
    for (; index < items.length; index++) {
      const media = await this.mediaService.getOne(items[index].mediaId).catch(() => null);
      file = media ? resolvePlayableFile(media, items[index].episodeId) : null;
      if (file) break;
    }
    if (!file || index >= items.length) return false;
    const start = items[index];

    // Cache the resolved file on the launched item so the player doesn't
    // re-resolve it; later items stay lazy (resolved on advance).
    const resolved = items.map((it, i) =>
      i === index ? { ...it, mediaFileId: file!.id } : it,
    );

    const targetId = this.remote.selectedTargetId();
    if (targetId) {
      // The queue drives only the local player: a remote target won't
      // consume it, so don't leave one behind for a later local play to inherit.
      this.queue.clear();
      remoteOverlayOpen.set(true);
      void this.remote.send(targetId, {
        action: 'load',
        mediaId: start.mediaId,
        mediaFileId: file.id,
        episodeId: start.episodeId,
      });
      return true;
    }

    if (this.castService.isConnected()) {
      // Cast plays the single launched item; the queue drives only the local
      // player, so don't leave a queue the Cast session won't consume.
      this.queue.clear();
      await this.castPlayer.quickStart({
        mediaFileId: file.id,
        mediaId: start.mediaId,
        episodeId: start.episodeId,
        title: start.title,
        episodeTitle: start.episodeTitle,
        fanartUrl: start.fanartUrl ?? null,
        streamInfo: file.streamInfo,
      });
      this.castPlayer.expanded.set(true);
      return true;
    }

    this.queue.start(resolved, index, {
      source: 'playlist',
      sourceId: playlistId,
      autoplay,
    });
    const qp: Record<string, number> = { mediaId: start.mediaId, playlistId };
    if (start.episodeId) qp['episodeId'] = start.episodeId;
    this.router.navigate(['/watch', file.id], {
      queryParams: qp,
      state: {
        fanartUrl: start.fanartUrl ?? null,
        stillUrl: start.stillUrl ?? null,
      },
    });
    return true;
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
