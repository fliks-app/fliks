import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { PlaybackState } from '../streaming/entities/playback-state.entity';
import { FliksRequest } from '../requests/entities/request.entity';
import { PairingRequest } from '../auth/pairing/entities/pairing-request.entity';
import { MediaType } from '../../common/enums';
import { RequestStatus } from '../../common/enums/request-status.enum';
import { UserStatsDto } from './dto/user-stats.dto';

const QUOTA_REQUEST_STATUSES = [RequestStatus.PENDING, RequestStatus.APPROVED];
const MAX_DEVICES_RETURNED = 10;

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
    @InjectRepository(PairingRequest)
    private readonly pairingRepo: Repository<PairingRequest>,
  ) {}

  async getUserStats(userId: number): Promise<UserStatsDto> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User #${userId} not found`);

    const since = new Date(Date.now() - user.quotaPeriodDays * 86400000);

    const [playback, requestsByStatus, requestsInPeriod, devices] = await Promise.all([
      this.aggregatePlayback(userId),
      this.countRequestsByStatus(userId),
      this.countRequestsInPeriod(userId, since),
      this.listApprovedDevices(userId),
    ]);

    return {
      playback,
      requests: {
        pending: requestsByStatus.pending,
        approved: requestsByStatus.approved,
        declined: requestsByStatus.declined,
        quotaPeriodDays: user.quotaPeriodDays,
        movieQuotaLimit: user.movieQuotaLimit,
        seriesQuotaLimit: user.seriesQuotaLimit,
        moviesInPeriod: requestsInPeriod.movies,
        seriesInPeriod: requestsInPeriod.series,
      },
      activity: {
        lastActiveAt: user.lastLogin?.toISOString() ?? null,
        memberSince: user.createdAt.toISOString(),
      },
      devices,
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

  private async countRequestsInPeriod(
    userId: number,
    since: Date,
  ): Promise<{ movies: number; series: number }> {
    const rows = await this.requestRepo
      .createQueryBuilder('r')
      .select('r."mediaType"', 'mediaType')
      .addSelect('COUNT(*)', 'count')
      .where('r."userId" = :userId', { userId })
      .andWhere('r."createdAt" >= :since', { since })
      .andWhere('r.status IN (:...statuses)', { statuses: QUOTA_REQUEST_STATUSES })
      .groupBy('r."mediaType"')
      .getRawMany<{ mediaType: MediaType; count: string }>();
    const byType = new Map(rows.map((r) => [r.mediaType, Number(r.count)]));
    return {
      movies: byType.get(MediaType.MOVIE) ?? 0,
      series: byType.get(MediaType.SERIES) ?? 0,
    };
  }

  private async listApprovedDevices(userId: number): Promise<UserStatsDto['devices']> {
    // Only include the most recent approval per (deviceId): a device that
    // was paired multiple times (e.g. unpaired and re-paired) shows once.
    const rows = await this.pairingRepo
      .createQueryBuilder('p')
      .select('p."deviceId"', 'deviceId')
      .addSelect('MAX(p."deviceName")', 'deviceName')
      .addSelect('MAX(p."createdAt")', 'pairedAt')
      .where('p."userId" = :userId', { userId })
      .andWhere('p.status = :status', { status: 'approved' })
      .groupBy('p."deviceId"')
      .orderBy('MAX(p."createdAt")', 'DESC')
      .limit(MAX_DEVICES_RETURNED)
      .getRawMany<{ deviceId: string; deviceName: string; pairedAt: string }>();

    const totalRow = await this.pairingRepo
      .createQueryBuilder('p')
      .select('COUNT(DISTINCT p."deviceId")', 'count')
      .where('p."userId" = :userId', { userId })
      .andWhere('p.status = :status', { status: 'approved' })
      .getRawOne<{ count: string }>();

    return {
      count: Number(totalRow?.count ?? 0),
      items: rows.map((r) => ({
        deviceId: r.deviceId,
        deviceName: r.deviceName,
        pairedAt: r.pairedAt,
      })),
    };
  }
}
