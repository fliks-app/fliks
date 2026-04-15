import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MediaServer } from '../users/entities/media-server.entity';
import { User } from '../users/entities/user.entity';
import { RolesService } from '../roles/roles.service';
import { Media } from '../media/entities/media.entity';
import { Episode } from '../media/entities/episode.entity';
import { Season } from '../media/entities/season.entity';
import { PlaybackState } from '../streaming/entities/playback-state.entity';
import { MediaType, MediaServerType } from '../../common/enums';
import { EmbyItem, EmbyProvider, EmbyUser } from './providers/emby.provider';

export interface ImportUserStats {
  username: string;
  created: boolean;
  imported: number;
  skipped: number;
  errors: number;
}

export interface ImportServerStats {
  users: number;
  usersCreated: number;
  imported: number;
  skipped: number;
  errors: string[];
  perUser: ImportUserStats[];
}

/** 1 tick = 100 ns = 10 000 000 ticks/second. */
const TICKS_PER_SECOND = 10_000_000;

function parseDate(raw?: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Import watch history from an Emby server into Suitarr `PlaybackState` rows.
 *
 * Matching strategy:
 *   - Users: by username (exact match). Missing users are auto-created with
 *     `passwordHash = null` (non-loggable until a reset-password flow exists).
 *   - Media: by `ProviderIds.Tmdb` → `Media(type, tmdbId)`. For episodes,
 *     we resolve the parent series' TMDB (Emby stores the TMDB on the series,
 *     not on the episode) and then match by season/episode number.
 *
 * Conflict resolution: if an existing `PlaybackState` has `lastPlayedAt`
 * strictly newer than the Emby value, we skip — Suitarr wins because the
 * user probably played the item locally since the last import.
 */
@Injectable()
export class EmbyWatchHistoryImportService {
  private readonly log = new Logger(EmbyWatchHistoryImportService.name);

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Media) private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(PlaybackState)
    private readonly playbackRepo: Repository<PlaybackState>,
    private readonly embyProvider: EmbyProvider,
    private readonly rolesService: RolesService,
  ) {}

  async importForServer(server: MediaServer): Promise<ImportServerStats> {
    if (server.type !== MediaServerType.EMBY) {
      throw new NotFoundException(
        `Server "${server.name}" is not an Emby server`,
      );
    }

    const stats: ImportServerStats = {
      users: 0,
      usersCreated: 0,
      imported: 0,
      skipped: 0,
      errors: [],
      perUser: [],
    };

    let embyUsers: EmbyUser[];
    try {
      embyUsers = await this.embyProvider.listUsers(server.url, server.apiKey);
    } catch (err) {
      const msg = `listUsers failed: ${(err as Error).message}`;
      this.log.error(msg);
      stats.errors.push(msg);
      return stats;
    }

    this.log.log(
      `Emby import[${server.name}]: ${embyUsers.length} user(s) on server`,
    );

    // Cache the TMDB→series lookup for episodes (Emby returns many episodes
    // per series and we don't want to re-fetch the series each time).
    const seriesByTmdb = new Map<number, Media | null>();
    // Same for TMDB→movie for similar reasons.
    const movieByTmdb = new Map<number, Media | null>();
    // Cache series-level tmdbId per Emby SeriesId so episodes from the same
    // series only cost one `getItem` call.
    const seriesTmdbByEmbyId = new Map<string, number | null>();

    for (const embyUser of embyUsers) {
      stats.users++;
      try {
        const userStats = await this.importForEmbyUser(
          server,
          embyUser,
          seriesByTmdb,
          movieByTmdb,
          seriesTmdbByEmbyId,
        );
        stats.perUser.push(userStats);
        stats.imported += userStats.imported;
        stats.skipped += userStats.skipped;
        if (userStats.created) stats.usersCreated++;
      } catch (err) {
        const msg = `user "${embyUser.Name}": ${(err as Error).message}`;
        this.log.error(msg);
        stats.errors.push(msg);
      }
    }

    this.log.log(
      `Emby import[${server.name}]: done — ${stats.users} user(s), ${stats.usersCreated} created, ${stats.imported} imported, ${stats.skipped} skipped`,
    );
    return stats;
  }

  private async importForEmbyUser(
    server: MediaServer,
    embyUser: EmbyUser,
    seriesByTmdb: Map<number, Media | null>,
    movieByTmdb: Map<number, Media | null>,
    seriesTmdbByEmbyId: Map<string, number | null>,
  ): Promise<ImportUserStats> {
    // 1. Resolve / create Suitarr user by username.
    let user = await this.userRepo.findOne({
      where: { username: embyUser.Name },
    });
    let created = false;
    if (!user) {
      const defaultRole = await this.rolesService.getDefaultRole();
      user = await this.userRepo.save({
        username: embyUser.Name,
        passwordHash: null,
        userRole: defaultRole ?? null,
        mediaServerType: MediaServerType.EMBY,
      } as unknown as User);
      created = true;
      this.log.log(
        `Emby import: created Suitarr user "${embyUser.Name}" (role=${defaultRole?.name ?? 'none'})`,
      );
    }

    const userStats: ImportUserStats = {
      username: embyUser.Name,
      created,
      imported: 0,
      skipped: 0,
      errors: 0,
    };

    // 2. Paginate through every played item.
    const batchSize = 500;
    let offset = 0;
    while (true) {
      const { items, total } = await this.embyProvider.getWatchedItems(
        server.url,
        server.apiKey,
        embyUser.Id,
        offset,
        batchSize,
      );
      if (!items.length) break;

      for (const item of items) {
        try {
          const handled = await this.applyItem(
            server,
            embyUser,
            user.id,
            item,
            seriesByTmdb,
            movieByTmdb,
            seriesTmdbByEmbyId,
          );
          if (handled) userStats.imported++;
          else userStats.skipped++;
        } catch (err) {
          userStats.errors++;
          this.log.warn(
            `Emby import: item "${item.Name}" (${item.Type}) skipped — ${(err as Error).message}`,
          );
        }
      }

      offset += items.length;
      if (offset >= total) break;
    }

    this.log.log(
      `Emby import[${embyUser.Name}]: ${userStats.imported} imported, ${userStats.skipped} skipped${created ? ' (user created)' : ''}`,
    );
    return userStats;
  }

  /**
   * Returns true when a marker was actually written (imported), false when
   * the item was skipped (no match, Suitarr newer, etc.).
   */
  private async applyItem(
    server: MediaServer,
    embyUser: EmbyUser,
    suitarrUserId: number,
    item: EmbyItem,
    seriesByTmdb: Map<number, Media | null>,
    movieByTmdb: Map<number, Media | null>,
    seriesTmdbByEmbyId: Map<string, number | null>,
  ): Promise<boolean> {
    // Fallback chain for the "history date":
    //   1. UserData.LastPlayedDate — the real thing (when Emby tracked it)
    //   2. DateCreated — when the item was added to the Emby library, gives
    //      a staggered realistic date even when actual play-dates are gone
    //      (common for items mass-marked "played" without real playback)
    //   3. PremiereDate — air/release date of the episode/movie
    //   4. now — last-ditch fallback so the item at least shows up
    const embyLastPlayed = parseDate(item.UserData?.LastPlayedDate);
    const embyDateCreated = parseDate(item.DateCreated);
    const embyPremiere = parseDate(item.PremiereDate);
    const resolvedDate =
      embyLastPlayed ?? embyDateCreated ?? embyPremiere ?? new Date();
    const playedAt = resolvedDate;
    const lastPlayed = resolvedDate;
    const positionSeconds = Math.floor(
      (item.UserData?.PlaybackPositionTicks ?? 0) / TICKS_PER_SECOND,
    );
    const durationSeconds = Math.floor(
      (item.RunTimeTicks ?? 0) / TICKS_PER_SECOND,
    );

    if (item.Type === 'Movie') {
      const tmdbId = Number(item.ProviderIds?.Tmdb);
      if (!Number.isFinite(tmdbId) || tmdbId <= 0) return false;
      let media = movieByTmdb.get(tmdbId);
      if (media === undefined) {
        media = await this.mediaRepo.findOne({
          where: { type: MediaType.MOVIE, tmdbId },
        });
        movieByTmdb.set(tmdbId, media);
      }
      if (!media) return false;

      return this.upsertPlaybackState({
        userId: suitarrUserId,
        mediaId: media.id,
        episodeId: null,
        positionSeconds,
        durationSeconds,
        lastPlayed,
        playedAt,
      });
    }

    // Episode path
    const seriesEmbyId = item.SeriesId;
    if (!seriesEmbyId) return false;

    // Cached lookup: Emby series → its TMDB id.
    let seriesTmdb = seriesTmdbByEmbyId.get(seriesEmbyId);
    if (seriesTmdb === undefined) {
      // Emby episodes don't carry the series' TMDB directly — fetch the series.
      const seriesItem = await this.embyProvider.getItem(
        server.url,
        server.apiKey,
        embyUser.Id,
        seriesEmbyId,
      );
      const raw = seriesItem?.ProviderIds?.Tmdb;
      seriesTmdb = raw && /^\d+$/.test(raw) ? Number(raw) : null;
      seriesTmdbByEmbyId.set(seriesEmbyId, seriesTmdb);
    }
    if (!seriesTmdb) return false;

    let series = seriesByTmdb.get(seriesTmdb);
    if (series === undefined) {
      series = await this.mediaRepo.findOne({
        where: { type: MediaType.SERIES, tmdbId: seriesTmdb },
      });
      seriesByTmdb.set(seriesTmdb, series);
    }
    if (!series) return false;

    const seasonNumber = item.ParentIndexNumber;
    const episodeNumber = item.IndexNumber;
    if (seasonNumber == null || episodeNumber == null) return false;

    const episode = await this.episodeRepo
      .createQueryBuilder('e')
      .innerJoin(Season, 's', 's.id = e."seasonId"')
      .where('s."mediaId" = :mediaId', { mediaId: series.id })
      .andWhere('s."seasonNumber" = :sn', { sn: seasonNumber })
      .andWhere('e."episodeNumber" = :en', { en: episodeNumber })
      .getOne();
    if (!episode) return false;

    return this.upsertPlaybackState({
      userId: suitarrUserId,
      mediaId: series.id,
      episodeId: episode.id,
      positionSeconds,
      durationSeconds,
      lastPlayed,
      playedAt,
    });
  }

  /**
   * Insert-or-update a PlaybackState row from Emby data. Returns true when
   * the row was actually touched; false when skipped because Suitarr has a
   * more recent record for this (user, media/episode).
   */
  private async upsertPlaybackState(opts: {
    userId: number;
    mediaId: number;
    episodeId: number | null;
    positionSeconds: number;
    durationSeconds: number;
    lastPlayed: Date;
    /** Resolved with a fallback chain (LastPlayed → DateCreated →
     *  PremiereDate → now) so history always has a displayable date. */
    playedAt: Date;
  }): Promise<boolean> {
    const qb = this.playbackRepo
      .createQueryBuilder('ps')
      .where('ps."userId" = :uid', { uid: opts.userId })
      .andWhere('ps."mediaId" = :mid', { mid: opts.mediaId });
    if (opts.episodeId) {
      qb.andWhere('ps."episodeId" = :eid', { eid: opts.episodeId });
    } else {
      qb.andWhere('ps."episodeId" IS NULL');
    }
    const existing = await qb.getOne();

    if (
      existing &&
      existing.lastPlayedAt &&
      existing.lastPlayedAt.getTime() > opts.lastPlayed.getTime()
    ) {
      return false;
    }

    if (existing) {
      existing.positionSeconds = opts.positionSeconds;
      if (opts.durationSeconds > 0) {
        existing.durationSeconds = opts.durationSeconds;
      }
      existing.completed = true;
      existing.lastPlayedAt = opts.lastPlayed;
      existing.playedAt = opts.playedAt;
      await this.playbackRepo.save(existing);
    } else {
      await this.playbackRepo.save({
        user: { id: opts.userId },
        media: { id: opts.mediaId },
        episode: opts.episodeId ? { id: opts.episodeId } : null,
        positionSeconds: opts.positionSeconds,
        durationSeconds: opts.durationSeconds,
        completed: true,
        lastPlayedAt: opts.lastPlayed,
        playedAt: opts.playedAt,
      } as Partial<PlaybackState>);
    }
    return true;
  }
}
