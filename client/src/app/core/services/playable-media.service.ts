import { Injectable, inject } from '@angular/core';
import { Media, MediaService } from './api/media.service';
import { ContinueWatchingItem, StreamingApiService } from './api/streaming-api.service';
import { PlaybackQueueService, QueueItem } from './playback-queue.service';
import { resolvePlayableFile } from '../../shared/utils/media-play.util';
import { PlaybackSession } from './playback/playback-session';
import type { LaunchTracks } from './track-manager.service';

export interface PlayContext {
  fileId: number;
  mediaId: number;
  episodeId?: number;
  /** The media when the caller already loaded it, so the output does not fetch it again. */
  media?: Media;
  /** Loading-screen backdrop of the local player: the episode still, else the fanart. */
  backdropUrl?: string | null;
  streamInfo?: any;
  /** Where the caller knows playback stopped. Only a caller that read it from a
   *  list has it; a detail page leaves the player to resolve its own. */
  positionSeconds?: number;
  /** Picks made on the detail header; the target honours them once, whichever it is. */
  tracks?: LaunchTracks;
}

/** Shared play/watched/Cast logic for media detail pages (movie + episode). */
@Injectable({ providedIn: 'root' })
export class PlayableMediaService {
  private readonly session = inject(PlaybackSession);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly mediaService = inject(MediaService);
  private readonly queue = inject(PlaybackQueueService);

  /** Resume a continue-watching row where the viewer left off. */
  resume(item: ContinueWatchingItem): Promise<void> {
    return this.play(
      {
        fileId: item.mediaFileId,
        mediaId: item.mediaId,
        positionSeconds: item.positionSeconds,
        episodeId: item.episodeId ?? undefined,
        backdropUrl: item.stillUrl ?? item.fanartUrl ?? item.posterUrl ?? null,
      },
      false,
    );
  }

  /** Plays a media file on the active output: a remote target, Cast, or the local player. */
  async play(ctx: PlayContext, fromStart: boolean) {
    // A standalone play is never part of a queue — drop any playlist queue so
    // the player doesn't inherit stale "up next" context from a prior session.
    this.queue.clear();
    const kind = await this.session.play(
      {
        fileId: ctx.fileId,
        mediaId: ctx.mediaId,
        episodeId: ctx.episodeId,
        media: ctx.media,
        backdropUrl: ctx.backdropUrl,
        streamInfo: ctx.streamInfo,
        positionSeconds: ctx.positionSeconds,
        tracks: ctx.tracks,
      },
      { fromStart },
    );
    if (kind !== 'local') return;
    // Warms the SWR cache (60 min TTL) so backing out of the player renders the detail page instantly.
    void this.mediaService.getOne(ctx.mediaId).catch(() => {});
    void this.mediaService.getCast(ctx.mediaId).catch(() => {});
    void this.mediaService.getCrew(ctx.mediaId).catch(() => {});
  }

  /** Registers the ordered queue and opens the player (or Cast); the player advances items on `autoplay`. Returns false when the item has no playable file. */
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

    // The queue drives only the local player: another output plays the launched item alone.
    if (this.session.isLocal()) this.queue.start(resolved, index, { source: 'playlist', sourceId: playlistId, autoplay });
    else this.queue.clear();
    await this.session.play(
      {
        fileId: file.id,
        mediaId: start.mediaId,
        episodeId: start.episodeId,
        backdropUrl: start.stillUrl ?? start.fanartUrl,
        streamInfo: file.streamInfo,
      },
      { query: { playlistId } },
    );
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
