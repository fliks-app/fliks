import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { PlaybackState } from './entities/playback-state.entity';

@Injectable()
export class PlaybackService {
  constructor(
    @InjectRepository(PlaybackState)
    private readonly repo: Repository<PlaybackState>,
  ) {}

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

  /**
   * Mark a playback session as started: ensure the playback_states row exists
   * and refresh `lastPlayedAt` / the linked file. The watch-history stamp
   * (`playedAt`) is intentionally NOT set here — a media enters the history
   * only once the heartbeat reports 5 s of progress, so an instant click-and-close never lands in it.
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
