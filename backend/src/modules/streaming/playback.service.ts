import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlaybackState } from './entities/playback-state.entity';

export interface ContinueWatchingItem {
  id: number;
  mediaId: number;
  mediaFileId: number;
  episodeId: number | null;
  positionSeconds: number;
  durationSeconds: number;
  progressPercent: number;
  lastPlayedAt: Date;
  mediaTitle: string;
  mediaType: string;
  posterUrl: string | null;
  episodeLabel: string | null;
}

@Injectable()
export class PlaybackService {
  constructor(
    @InjectRepository(PlaybackState)
    private readonly repo: Repository<PlaybackState>,
  ) {}

  async getState(
    userId: number,
    mediaFileId: number,
  ): Promise<PlaybackState | null> {
    return this.repo.findOne({ where: { userId, mediaFileId } });
  }

  async updateState(
    userId: number,
    mediaFileId: number,
    body: {
      positionSeconds: number;
      durationSeconds: number;
      mediaId: number;
      episodeId?: number;
    },
  ): Promise<PlaybackState> {
    let state = await this.repo.findOne({ where: { userId, mediaFileId } });

    const dur = body.durationSeconds ?? 0;
    const pos = body.positionSeconds ?? 0;
    const completed = dur > 0 && pos >= dur * 0.9;

    if (state) {
      state.positionSeconds = pos;
      if (dur > 0) state.durationSeconds = dur;
      state.completed = completed;
      state.lastPlayedAt = new Date();
    } else {
      state = this.repo.create({
        userId,
        mediaFileId,
        mediaId: body.mediaId,
        episodeId: body.episodeId,
        positionSeconds: pos,
        durationSeconds: dur || 0,
        completed,
        lastPlayedAt: new Date(),
      });
    }

    return this.repo.save(state);
  }

  async getContinueWatching(userId: number): Promise<ContinueWatchingItem[]> {
    const rows = await this.repo
      .createQueryBuilder('ps')
      .innerJoinAndSelect('ps.media', 'media')
      .leftJoinAndSelect('media.rootFolder', 'rootFolder')
      .where('ps.userId = :userId', { userId })
      .andWhere('ps.completed = false')
      .andWhere('ps.positionSeconds > 0')
      .orderBy('ps.lastPlayedAt', 'DESC')
      .take(20)
      .getMany();

    return rows.map((ps) => {
      const progress =
        ps.durationSeconds > 0
          ? Math.round((ps.positionSeconds / ps.durationSeconds) * 100)
          : 0;
      return {
        id: ps.id,
        mediaId: ps.mediaId,
        mediaFileId: ps.mediaFileId,
        episodeId: ps.episodeId,
        positionSeconds: ps.positionSeconds,
        durationSeconds: ps.durationSeconds,
        progressPercent: progress,
        lastPlayedAt: ps.lastPlayedAt,
        mediaTitle: ps.media?.title ?? '',
        mediaType: ps.media?.type ?? '',
        posterUrl: ps.media?.posterUrl ?? null,
        episodeLabel: null, // TODO: resolve episode label
      };
    });
  }

  async getHistory(
    userId: number,
    page: number,
    limit: number,
  ): Promise<{ data: PlaybackState[]; total: number }> {
    const [data, total] = await this.repo.findAndCount({
      where: { userId },
      relations: ['media'],
      order: { lastPlayedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total };
  }

  async deleteState(userId: number, mediaFileId: number): Promise<void> {
    await this.repo.delete({ userId, mediaFileId });
  }
}
