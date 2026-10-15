import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { User } from '../users/entities/user.entity';
import { PlaybackState } from './entities/playback-state.entity';
import { PlaylistsService } from '../playlists/playlists.service';

/**
 * Minimum watched position before a media enters the watch history
 * (`playedAt` stamp) or continue-watching. Keeps an accidental click that's
 * closed within a few seconds out of both — only a real watch (≥ 5 s) records.
 */
const HISTORY_MIN_WATCH_SECONDS = 5;

/** Postgres foreign-key violation. Library refresh can drop the parent media
 *  row mid-session; cascade clears existing playback_states, then a beacon
 *  arrives for that mediaId and the fresh INSERT trips this FK. */
const PG_FK_VIOLATION = '23503';

@Injectable()
export class PlaybackService {
  private readonly log = new Logger(PlaybackService.name);

  constructor(
    @InjectRepository(PlaybackState)
    private readonly repo: Repository<PlaybackState>,
    private readonly playlists: PlaylistsService,
  ) {}

  /**
   * Fire the playlist auto-remove hook for an item the user just finished,
   * isolating any failure: a playlist write must never break recording a
   * watch. `episodeIds` is `null` for a movie, or the finished episode ids.
   */
  private async autoRemoveFromPlaylists(
    userId: number,
    mediaId: number,
    episodeIds: number[] | null,
  ): Promise<void> {
    try {
      await this.playlists.removeWatchedFromAutoPlaylists(
        userId,
        mediaId,
        episodeIds,
      );
    } catch (err) {
      this.log.warn(
        `Playlist auto-remove failed for media #${mediaId}: ${
          (err as Error).message
        }`,
      );
    }
  }

  /** Find state by media/episode. */
  private findState(
    userId: number,
    mediaId: number,
    episodeId?: number,
  ): Promise<PlaybackState | null> {
    return this.repo.findOne({
      where: {
        user: { id: userId },
        media: { id: mediaId },
        episode: episodeId
          ? { id: episodeId }
          : (IsNull() as unknown as { id: number }),
      },
    });
  }

  async getState(
    userId: number,
    mediaId: number,
    episodeId?: number,
  ): Promise<PlaybackState | null> {
    return this.findState(userId, mediaId, episodeId);
  }

  async updateState(
    userId: number,
    mediaId: number,
    body: {
      positionSeconds: number;
      durationSeconds: number;
      mediaFileId: number;
      episodeId?: number;
    },
  ): Promise<PlaybackState | null> {
    if (!mediaId || !body.mediaFileId) {
      throw new BadRequestException('mediaId and mediaFileId are required');
    }
    let state = await this.findState(userId, mediaId, body.episodeId);
    const wasCompleted = state?.completed ?? false;

    const dur = body.durationSeconds ?? 0;
    const pos = body.positionSeconds ?? 0;
    const completed = dur > 0 && (pos >= dur - 30 || pos >= dur * 0.9);
    const now = new Date();
    // Enter (or refresh) the watch history only once a real watch threshold is
    // crossed, so an accidental click closed within a few seconds never lands
    // in history. `playedAt` is the history marker; below the threshold we
    // leave it untouched (null on a fresh row).
    const watched = pos >= HISTORY_MIN_WATCH_SECONDS;

    if (state) {
      state.positionSeconds = pos;
      if (dur > 0) state.durationSeconds = dur;
      state.completed = completed;
      state.hiddenFromContinueWatching = false;
      state.lastPlayedAt = now;
      if (watched) state.playedAt = now;
      state.mediaFile = { id: body.mediaFileId } as MediaFile;
    } else {
      state = this.repo.create({
        user: { id: userId } as User,
        media: { id: mediaId } as Media,
        mediaFile: { id: body.mediaFileId } as MediaFile,
        episode:
          body.episodeId != null ? ({ id: body.episodeId } as Episode) : null,
        positionSeconds: pos,
        durationSeconds: dur || 0,
        completed,
        lastPlayedAt: now,
        playedAt: watched ? now : null,
      });
    }

    try {
      const saved = await this.repo.save(state);
      if (completed && !wasCompleted) {
        await this.autoRemoveFromPlaylists(
          userId,
          mediaId,
          body.episodeId != null ? [body.episodeId] : null,
        );
      }
      return saved;
    } catch (err) {
      if ((err as { code?: string })?.code === PG_FK_VIOLATION) return null;
      throw err;
    }
  }

  /**
   * Mark a playback session as started: ensure the playback_states row exists
   * and refresh `lastPlayedAt` / the linked file. The watch-history stamp
   * (`playedAt`) is intentionally NOT set here — a media enters the history
   * only once {@link HISTORY_MIN_WATCH_SECONDS} of progress is reported through
   * {@link updateState}, so an instant click-and-close never lands in it.
   * Called by the streaming controller at playback-info time.
   */
  async markSessionStarted(
    userId: number,
    mediaId: number,
    mediaFileId: number,
    episodeId?: number | null,
  ): Promise<void> {
    const state = await this.findState(userId, mediaId, episodeId ?? undefined);
    const now = new Date();
    if (state) {
      state.lastPlayedAt = now;
      if (mediaFileId) state.mediaFileId = mediaFileId;
      await this.repo.save(state);
    } else {
      await this.repo.save({
        user: { id: userId },
        media: { id: mediaId },
        mediaFile: mediaFileId ? { id: mediaFileId } : null,
        episode: episodeId != null ? { id: episodeId } : null,
        positionSeconds: 0,
        durationSeconds: 0,
        completed: false,
        lastPlayedAt: now,
      } as Partial<PlaybackState>);
    }
  }
}
