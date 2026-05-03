import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { PlaybackState } from '../streaming/entities/playback-state.entity';
import { FliksRequest } from '../requests/entities/request.entity';
import { MediaType } from '../../common/enums';
import { RequestStatus } from '../../common/enums/request-status.enum';
import { UserStatsDto } from './dto/user-stats.dto';

/**
 * Aggregates per-user activity for the admin user-detail Statistics tab.
 * Each method runs a focused indexed query; the controller composes them
 * in parallel via Promise.all so the round trip stays under ~one DB hop.
 */
@Injectable()
export class UsersStatsService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(PlaybackState)
    private readonly playbackRepo: Repository<PlaybackState>,
    @InjectRepository(FliksRequest)
    private readonly requestRepo: Repository<FliksRequest>,
  ) {}

  async getUserStats(userId: number): Promise<UserStatsDto> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User #${userId} not found`);

    const [playback, requestsByStatus] = await Promise.all([
      this.aggregatePlayback(userId),
      this.countRequestsByStatus(userId),
    ]);

    return {
      playback,
      requests: requestsByStatus,
      activity: {
        lastActiveAt: user.lastLogin?.toISOString() ?? null,
        memberSince: user.createdAt.toISOString(),
      },
    };
  }

  private async aggregatePlayback(userId: number): Promise<UserStatsDto['playback']> {
    // One pass for the four COUNT/SUM aggregates, joined to media for the
    // type filter (movie vs series). Distinct on mediaId / episodeId so a
    // user with multiple PlaybackState rows for the same media (e.g. one per
    // episode of a series) doesn't get double-counted at the title level.
    const totals = await this.playbackRepo
      .createQueryBuilder('ps')
      .leftJoin('ps.media', 'media')
      .select(
        'COALESCE(SUM(CASE WHEN ps."playedAt" IS NOT NULL THEN ps."positionSeconds" ELSE 0 END), 0)',
        'totalWatchTimeSeconds',
      )
      .addSelect(
        'COUNT(DISTINCT CASE WHEN ps.completed AND media.type = :movie THEN ps."mediaId" END)',
        'moviesWatched',
      )
      .addSelect(
        'COUNT(DISTINCT CASE WHEN ps.completed AND media.type = :series THEN ps."mediaId" END)',
        'seriesStarted',
      )
      .addSelect(
        'COUNT(DISTINCT CASE WHEN ps.completed AND ps."episodeId" IS NOT NULL THEN ps."episodeId" END)',
        'episodesWatched',
      )
      .addSelect('MAX(ps."lastPlayedAt")', 'lastPlayedAt')
      .where('ps."userId" = :userId', { userId })
      .setParameters({ movie: MediaType.MOVIE, series: MediaType.SERIES })
      .getRawOne<{
        totalWatchTimeSeconds: string;
        moviesWatched: string;
        seriesStarted: string;
        episodesWatched: string;
        lastPlayedAt: string | null;
      }>();

    return {
      totalWatchTimeSeconds: Math.round(Number(totals?.totalWatchTimeSeconds ?? 0)),
      moviesWatched: Number(totals?.moviesWatched ?? 0),
      seriesStarted: Number(totals?.seriesStarted ?? 0),
      episodesWatched: Number(totals?.episodesWatched ?? 0),
      lastPlayedAt: totals?.lastPlayedAt ?? null,
    };
  }

  private async countRequestsByStatus(
    userId: number,
  ): Promise<{ pending: number; approved: number; declined: number }> {
    const rows = await this.requestRepo
      .createQueryBuilder('r')
      .select('r.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('r."userId" = :userId', { userId })
      .groupBy('r.status')
      .getRawMany<{ status: RequestStatus; count: string }>();
    const byStatus = new Map(rows.map((r) => [r.status, Number(r.count)]));
    return {
      pending: byStatus.get(RequestStatus.PENDING) ?? 0,
      approved: byStatus.get(RequestStatus.APPROVED) ?? 0,
      declined: byStatus.get(RequestStatus.DECLINED) ?? 0,
    };
  }

}
