import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { Playlist } from './entities/playlist.entity';
import { PlaylistItem } from './entities/playlist-item.entity';
import { PlaylistShare } from './entities/playlist-share.entity';
import { Media } from '../media/entities/media.entity';
import { Episode } from '../media/entities/episode.entity';
import { PlaybackState } from '../streaming/entities/playback-state.entity';
import { UserFollow } from '../social/entities/user-follow.entity';
import { User } from '../users/entities/user.entity';
import { LibrariesService } from '../libraries/libraries.service';
import {
  FollowStatus,
  MediaType,
  PlaylistShareRole,
  PlaylistVisibility,
} from '../../common/enums';
import { CreatePlaylistDto } from './dto/create-playlist.dto';
import { UpdatePlaylistDto } from './dto/update-playlist.dto';
import { AddPlaylistItemDto } from './dto/add-playlist-item.dto';
import { ReorderPlaylistItemsDto } from './dto/reorder-playlist-items.dto';

/** Owner has every capability; the enum ranks the three shared roles. */
export type PlaylistRole = 'owner' | PlaylistShareRole;

const ROLE_RANK: Record<PlaylistShareRole, number> = {
  [PlaylistShareRole.VIEWER]: 1,
  [PlaylistShareRole.EDITOR]: 2,
  [PlaylistShareRole.ADMINISTRATOR]: 3,
};

export interface PlaylistView {
  id: number;
  name: string;
  ownerId: number;
  role: PlaylistRole;
  autoRemoveWatched: boolean;
  autoDownload: boolean;
  autoPlay: boolean;
  visibility: PlaylistVisibility;
  coverImageUrl: string | null;
  itemCount: number;
  posters: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PlaylistItemView {
  itemId: number;
  position: number;
  addedById: number | null;
  /** The movie, or the parent series when this item is an episode. */
  media: Media;
  /** Set when the item is a single episode; null for a movie item. */
  episode: Episode | null;
  /** The requesting user's watch progress on this item (0–100). */
  progressPercent: number;
  /** Whether the requesting user finished this item. */
  watched: boolean;
}

@Injectable()
export class PlaylistsService {
  constructor(
    @InjectRepository(Playlist)
    private readonly repo: Repository<Playlist>,
    @InjectRepository(PlaylistItem)
    private readonly itemRepo: Repository<PlaylistItem>,
    @InjectRepository(PlaylistShare)
    private readonly shareRepo: Repository<PlaylistShare>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(PlaybackState)
    private readonly playbackRepo: Repository<PlaybackState>,
    @InjectRepository(UserFollow)
    private readonly followRepo: Repository<UserFollow>,
    private readonly libraries: LibrariesService,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // Access control
  // ---------------------------------------------------------------------------

  /**
   * Resolve the caller's role on a playlist and reject if it is below `min`.
   * The owner short-circuits with full rights. Non-members get a 404 so the
   * playlist's existence isn't leaked; members below `min` get a 403.
   */
  private async assertRole(
    user: User,
    playlistId: number,
    min: PlaylistShareRole,
  ): Promise<{ playlist: Playlist; role: PlaylistRole }> {
    const playlist = await this.repo.findOne({ where: { id: playlistId } });
    if (!playlist) {
      throw new NotFoundException(`Playlist #${playlistId} not found`);
    }
    if (playlist.ownerId === user.id) return { playlist, role: 'owner' };

    // Public / followers visibility grants read-only access without a share.
    // (Write paths pass EDITOR/ADMINISTRATOR, so they never take this branch.)
    if (min === PlaylistShareRole.VIEWER) {
      if (playlist.visibility === PlaylistVisibility.PUBLIC) {
        return { playlist, role: PlaylistShareRole.VIEWER };
      }
      if (playlist.visibility === PlaylistVisibility.FOLLOWERS) {
        const followsOwner = await this.followRepo.exist({
          where: {
            follower: { id: user.id },
            following: { id: playlist.ownerId },
            status: FollowStatus.ACCEPTED,
          },
        });
        if (followsOwner) return { playlist, role: PlaylistShareRole.VIEWER };
      }
    }

    const share = await this.shareRepo.findOne({
      where: { playlist: { id: playlistId }, user: { id: user.id } },
    });
    if (!share) throw new NotFoundException(`Playlist #${playlistId} not found`);
    if (ROLE_RANK[share.role] < ROLE_RANK[min]) {
      throw new ForbiddenException('Insufficient playlist role');
    }
    return { playlist, role: share.role };
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /** Playlists the caller owns or has been shared, with per-viewer cover/count. */
  async findAccessibleForUser(user: User): Promise<PlaylistView[]> {
    const owned = await this.repo.find({ where: { owner: { id: user.id } } });
    const shares = await this.shareRepo.find({
      where: { user: { id: user.id } },
      relations: ['playlist'],
    });

    const byId = new Map<number, { playlist: Playlist; role: PlaylistRole }>();
    for (const p of owned) byId.set(p.id, { playlist: p, role: 'owner' });
    for (const s of shares) {
      if (s.playlist && !byId.has(s.playlist.id)) {
        byId.set(s.playlist.id, { playlist: s.playlist, role: s.role });
      }
    }

    const entries = [...byId.values()];
    if (!entries.length) return [];

    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    const stats = await this.postersAndCounts(
      entries.map((e) => e.playlist.id),
      accessible,
    );
    return entries
      .map((e) => this.toView(e.playlist, e.role, stats.get(e.playlist.id)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * A target user's playlists visible on their public profile: always the
   * PUBLIC ones, plus FOLLOWERS ones when `includeFollowers` (the viewer is an
   * accepted follower). Posters/counts scoped to the VIEWER's library access.
   */
  async listVisibleForOwner(
    ownerId: number,
    viewer: User,
    includeFollowers: boolean,
  ): Promise<PlaylistView[]> {
    const visibilities = includeFollowers
      ? [PlaylistVisibility.PUBLIC, PlaylistVisibility.FOLLOWERS]
      : [PlaylistVisibility.PUBLIC];
    const playlists = await this.repo.find({
      where: { owner: { id: ownerId }, visibility: In(visibilities) },
    });
    if (!playlists.length) return [];
    const accessible = await this.libraries.getAccessibleLibraryIds(viewer);
    const stats = await this.postersAndCounts(
      playlists.map((p) => p.id),
      accessible,
    );
    return playlists
      .map((p) => this.toView(p, PlaylistShareRole.VIEWER, stats.get(p.id)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async findOneForUser(user: User, playlistId: number): Promise<PlaylistView> {
    const { playlist, role } = await this.assertRole(
      user,
      playlistId,
      PlaylistShareRole.VIEWER,
    );
    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    const stats = (await this.postersAndCounts([playlistId], accessible)).get(
      playlistId,
    );
    return this.toView(playlist, role, stats);
  }

  /**
   * Ordered media in the playlist, filtered to what the caller may see: media
   * in a library the caller lacks access to are omitted (shared members
   * included). Enforced with the *caller's* accessible library ids.
   */
  async getItems(user: User, playlistId: number): Promise<PlaylistItemView[]> {
    await this.assertRole(user, playlistId, PlaylistShareRole.VIEWER);
    const items = await this.itemRepo.find({
      where: { playlist: { id: playlistId } },
      order: { position: 'ASC' },
    });
    if (!items.length) return [];

    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    const media = await this.mediaRepo.find({
      where: {
        id: In(items.map((i) => i.mediaId)),
        library: { id: In(accessible.length ? accessible : [-1]) },
      },
      relations: ['library'],
    });
    const byId = new Map(media.map((m) => [m.id, m]));

    // The client has no standalone episode fetch, so inline the episode fields
    // (season/episode numbers, title, still) needed to render episode items.
    const epIds = items
      .map((i) => i.episodeId)
      .filter((id): id is number => id != null);
    const episodes = epIds.length
      ? await this.episodeRepo.find({
          where: { id: In(epIds) },
          relations: ['season'],
        })
      : [];
    const epById = new Map(episodes.map((e) => [e.id, e]));

    // Per-item watch progress for this user (movie: media playback with no
    // episode; episode: the episode's playback), for the progress bar.
    const movieMediaIds = items
      .filter((i) => i.episodeId == null)
      .map((i) => i.mediaId);
    const where: Record<string, unknown>[] = [];
    if (movieMediaIds.length) {
      where.push({
        user: { id: user.id },
        media: { id: In(movieMediaIds) },
        episode: IsNull(),
      });
    }
    if (epIds.length) {
      where.push({ user: { id: user.id }, episode: { id: In(epIds) } });
    }
    const states = where.length
      ? await this.playbackRepo.find({ where })
      : [];
    const psByMovie = new Map<number, PlaybackState>();
    const psByEpisode = new Map<number, PlaybackState>();
    for (const s of states) {
      if (s.episodeId == null) psByMovie.set(s.mediaId, s);
      else psByEpisode.set(s.episodeId, s);
    }
    const progressOf = (
      s: PlaybackState | undefined,
    ): { progressPercent: number; watched: boolean } => {
      if (!s) return { progressPercent: 0, watched: false };
      if (s.completed) return { progressPercent: 100, watched: true };
      const pct =
        s.durationSeconds > 0
          ? Math.min(100, Math.round((s.positionSeconds / s.durationSeconds) * 100))
          : 0;
      return { progressPercent: pct, watched: false };
    };

    return items
      .filter((i) => byId.has(i.mediaId))
      .map((i) => {
        const ps =
          i.episodeId != null
            ? psByEpisode.get(i.episodeId)
            : psByMovie.get(i.mediaId);
        return {
          itemId: i.id,
          position: i.position,
          addedById: i.addedById,
          media: byId.get(i.mediaId) as Media,
          episode:
            i.episodeId != null ? (epById.get(i.episodeId) ?? null) : null,
          ...progressOf(ps),
        };
      });
  }

  // ---------------------------------------------------------------------------
  // Write — playlist
  // ---------------------------------------------------------------------------

  async create(user: User, dto: CreatePlaylistDto): Promise<PlaylistView> {
    const playlist = await this.repo.save(
      this.repo.create({
        name: dto.name.trim(),
        owner: { id: user.id } as User,
        autoRemoveWatched: dto.autoRemoveWatched ?? false,
        autoDownload: dto.autoDownload ?? false,
        autoPlay: dto.autoPlay ?? false,
      }),
    );
    return this.findOneForUser(user, playlist.id);
  }

  async update(
    user: User,
    playlistId: number,
    dto: UpdatePlaylistDto,
  ): Promise<PlaylistView> {
    await this.assertRole(user, playlistId, PlaylistShareRole.ADMINISTRATOR);
    const patch: Partial<Playlist> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.autoRemoveWatched !== undefined) {
      patch.autoRemoveWatched = dto.autoRemoveWatched;
    }
    if (dto.autoDownload !== undefined) patch.autoDownload = dto.autoDownload;
    if (dto.autoPlay !== undefined) patch.autoPlay = dto.autoPlay;
    if (dto.visibility !== undefined) patch.visibility = dto.visibility;
    if (Object.keys(patch).length) await this.repo.update(playlistId, patch);
    return this.findOneForUser(user, playlistId);
  }

  async remove(user: User, playlistId: number): Promise<void> {
    const { playlist } = await this.assertRole(
      user,
      playlistId,
      PlaylistShareRole.VIEWER,
    );
    if (playlist.ownerId !== user.id) {
      throw new ForbiddenException('Only the owner can delete a playlist');
    }
    await this.repo.remove(playlist);
  }

  // ---------------------------------------------------------------------------
  // Write — items
  // ---------------------------------------------------------------------------

  /**
   * Add to a playlist. The body picks the scope: a movie (`mediaId` → a movie),
   * a single episode (`episodeId`), a whole season (`seasonId`) or a whole
   * series (`mediaId` → a series). Season/series expand server-side to one row
   * per episode in a single transaction, skipping items already present, and
   * only touching media the caller can access. Returns how many rows were added.
   */
  async addItem(
    user: User,
    playlistId: number,
    dto: AddPlaylistItemDto,
  ): Promise<{ added: number }> {
    await this.assertRole(user, playlistId, PlaylistShareRole.EDITOR);
    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    const accessibleIds = accessible.length ? accessible : [-1];

    const { targets, bulk } = await this.resolveAddTargets(dto, accessibleIds);
    if (!targets.length) return { added: 0 };

    const runInsert = (): Promise<{ added: number }> =>
      this.dataSource.transaction(async (m) => {
        const itemRepo = m.getRepository(PlaylistItem);
        const existing = await itemRepo.find({
          where: { playlist: { id: playlistId } },
        });
        const movieIds = new Set(
          existing.filter((e) => e.episodeId == null).map((e) => e.mediaId),
        );
        const epIds = new Set(
          existing.filter((e) => e.episodeId != null).map((e) => e.episodeId),
        );
        const fresh = targets.filter((t) =>
          t.episodeId != null ? !epIds.has(t.episodeId) : !movieIds.has(t.mediaId),
        );
        if (!fresh.length) {
          // A single explicit add of an item already present is the "duplicate"
          // case the UI surfaces; a bulk add just reports nothing new.
          if (!bulk) {
            throw new BadRequestException('errors.media_already_in_playlist');
          }
          return { added: 0 };
        }

        const maxRow = await itemRepo
          .createQueryBuilder('i')
          .select('MAX(i.position)', 'max')
          .where('i."playlistId" = :pid', { pid: playlistId })
          .getRawOne<{ max: number | null }>();
        let position = maxRow?.max != null ? Number(maxRow.max) + 1 : 0;

        const rows = fresh.map((t) =>
          itemRepo.create({
            playlist: { id: playlistId } as Playlist,
            media: { id: t.mediaId } as Media,
            episode: t.episodeId != null ? ({ id: t.episodeId } as Episode) : null,
            addedBy: { id: user.id } as User,
            position: position++,
          }),
        );
        await itemRepo.save(rows);
        // Reflect item changes in updatedAt (it otherwise only moves on rename).
        await m.update(Playlist, playlistId, { updatedAt: () => 'now()' });
        return { added: rows.length };
      });

    try {
      return await runInsert();
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      if ((err as { code?: string }).code !== '23505') throw err;
      // Partial unique index violation — a concurrent add raced past the
      // skip-existing check. A single add is the "duplicate" case the UI
      // surfaces; a bulk add retries once so skip-existing now sees the
      // concurrently-inserted rows (and no-ops cleanly if it races again).
      if (!bulk) {
        throw new BadRequestException('errors.media_already_in_playlist');
      }
      try {
        return await runInsert();
      } catch (retry) {
        if (retry instanceof BadRequestException) throw retry;
        if ((retry as { code?: string }).code === '23505') return { added: 0 };
        throw retry;
      }
    }
  }

  /**
   * Turn an add request into the concrete rows to insert, validating the
   * caller's library access. `bulk` = a season/series expansion (skip
   * already-present episodes) vs a single movie/episode add.
   */
  private async resolveAddTargets(
    dto: AddPlaylistItemDto,
    accessibleIds: number[],
  ): Promise<{
    targets: { mediaId: number; episodeId: number | null }[];
    bulk: boolean;
  }> {
    // Single episode
    if (dto.episodeId != null) {
      const ep = await this.episodeRepo.findOne({
        where: { id: dto.episodeId },
        relations: ['season'],
      });
      if (!ep?.season) {
        throw new NotFoundException(`Episode #${dto.episodeId} not found`);
      }
      await this.assertAccessibleSeries(ep.season.mediaId, accessibleIds);
      return {
        targets: [{ mediaId: ep.season.mediaId, episodeId: dto.episodeId }],
        bulk: false,
      };
    }

    // Whole season
    if (dto.seasonId != null) {
      const eps = await this.episodeRepo.find({
        where: { season: { id: dto.seasonId } },
        relations: ['season'],
        order: { episodeNumber: 'ASC' },
      });
      if (!eps.length) return { targets: [], bulk: true };
      const seriesId = eps[0].season.mediaId;
      await this.assertAccessibleSeries(seriesId, accessibleIds);
      return {
        targets: eps.map((e) => ({ mediaId: seriesId, episodeId: e.id })),
        bulk: true,
      };
    }

    // Movie or whole series (by media id)
    if (dto.mediaId != null) {
      const media = await this.mediaRepo.findOne({
        where: { id: dto.mediaId, library: { id: In(accessibleIds) } },
      });
      if (!media) throw new NotFoundException(`Media #${dto.mediaId} not found`);
      if (media.type === MediaType.SERIES) {
        const eps = await this.episodeRepo.find({
          where: { season: { media: { id: dto.mediaId } } },
          relations: ['season'],
        });
        eps.sort(
          (a, b) =>
            a.season.seasonNumber - b.season.seasonNumber ||
            a.episodeNumber - b.episodeNumber,
        );
        return {
          targets: eps.map((e) => ({ mediaId: media.id, episodeId: e.id })),
          bulk: true,
        };
      }
      return { targets: [{ mediaId: dto.mediaId, episodeId: null }], bulk: false };
    }

    throw new BadRequestException('errors.playlist_add_target_required');
  }

  private async assertAccessibleSeries(
    seriesId: number,
    accessibleIds: number[],
  ): Promise<void> {
    const series = await this.mediaRepo.findOne({
      where: {
        id: seriesId,
        type: MediaType.SERIES,
        library: { id: In(accessibleIds) },
      },
    });
    if (!series) throw new NotFoundException(`Series #${seriesId} not found`);
  }

  async removeItem(
    user: User,
    playlistId: number,
    itemId: number,
  ): Promise<void> {
    await this.assertRole(user, playlistId, PlaylistShareRole.EDITOR);
    const res = await this.itemRepo.delete({
      id: itemId,
      playlist: { id: playlistId },
    });
    if (!res.affected) {
      throw new NotFoundException(`Playlist item #${itemId} not found`);
    }
    // Reflect item changes in updatedAt (it otherwise only moves on rename).
    await this.repo.update(playlistId, { updatedAt: () => 'now()' });
  }

  /** Remove every item of one media from the playlist — for a series this is
   *  all its episode rows (they all carry the series' mediaId). */
  async removeItemsByMedia(
    user: User,
    playlistId: number,
    mediaId: number,
  ): Promise<{ removed: number }> {
    await this.assertRole(user, playlistId, PlaylistShareRole.EDITOR);
    const res = await this.itemRepo.delete({
      playlist: { id: playlistId },
      media: { id: mediaId },
    });
    if (res.affected) {
      // Reflect item changes in updatedAt (it otherwise only moves on rename).
      await this.repo.update(playlistId, { updatedAt: () => 'now()' });
    }
    return { removed: res.affected ?? 0 };
  }

  /**
   * Auto-remove hook for finished playback: drop the matching row(s) from every
   * playlist the user *owns* that has `autoRemoveWatched` on. Scoped to owned
   * playlists so one member finishing an item never mutates a shared list for
   * the others. Called from the playback path when a `PlaybackState` transitions
   * to completed; the caller isolates failures so a playlist write can't break
   * recording the watch.
   *
   * `episodeIds` picks the target: `null` matches the movie row (episode NULL);
   * a list matches those episode rows (a single toggle passes one id, a
   * season/series mark-watched passes many). An empty list is a no-op.
   */
  async removeWatchedFromAutoPlaylists(
    userId: number,
    mediaId: number,
    episodeIds: number[] | null,
  ): Promise<void> {
    if (episodeIds != null && !episodeIds.length) return;
    const playlists = await this.repo.find({
      where: { owner: { id: userId }, autoRemoveWatched: true },
    });
    if (!playlists.length) return;

    const qb = this.itemRepo
      .createQueryBuilder()
      .delete()
      .from(PlaylistItem)
      .where('"playlistId" IN (:...playlistIds)', {
        playlistIds: playlists.map((p) => p.id),
      })
      .andWhere('"mediaId" = :mediaId', { mediaId });
    if (episodeIds == null) qb.andWhere('"episodeId" IS NULL');
    else qb.andWhere('"episodeId" IN (:...episodeIds)', { episodeIds });
    await qb.execute();
  }

  async reorder(
    user: User,
    playlistId: number,
    dto: ReorderPlaylistItemsDto,
  ): Promise<void> {
    await this.assertRole(user, playlistId, PlaylistShareRole.EDITOR);
    const items = await this.itemRepo.find({
      where: { playlist: { id: playlistId } },
    });
    const ids = new Set(items.map((i) => i.id));
    const unique = new Set(dto.itemIds);
    if (
      unique.size !== dto.itemIds.length ||
      dto.itemIds.length !== items.length ||
      dto.itemIds.some((id) => !ids.has(id))
    ) {
      throw new BadRequestException(
        'itemIds must list every item in the playlist exactly once',
      );
    }
    await this.dataSource.transaction(async (m) => {
      for (let idx = 0; idx < dto.itemIds.length; idx++) {
        await m.update(PlaylistItem, { id: dto.itemIds[idx] }, { position: idx });
      }
      // Reflect item changes in updatedAt (it otherwise only moves on rename).
      await m.update(Playlist, playlistId, { updatedAt: () => 'now()' });
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private toView(
    playlist: Playlist,
    role: PlaylistRole,
    stats: { count: number; posters: string[] } | undefined,
  ): PlaylistView {
    return {
      id: playlist.id,
      name: playlist.name,
      ownerId: playlist.ownerId,
      role,
      autoRemoveWatched: playlist.autoRemoveWatched,
      autoDownload: playlist.autoDownload,
      autoPlay: playlist.autoPlay,
      visibility: playlist.visibility,
      coverImageUrl: playlist.coverImageUrl,
      itemCount: stats?.count ?? 0,
      posters: stats?.posters ?? [],
      createdAt: playlist.createdAt,
      updatedAt: playlist.updatedAt,
    };
  }

  /**
   * Per-playlist item count + first four posters, scoped to the libraries the
   * viewer may access — so a shared member never sees a poster (or a count)
   * for media outside their library access. Ordered by playlist position.
   */
  private async postersAndCounts(
    playlistIds: number[],
    accessibleLibraryIds: number[],
  ): Promise<Map<number, { count: number; posters: string[] }>> {
    const map = new Map<number, { count: number; posters: string[] }>();
    if (!playlistIds.length || !accessibleLibraryIds.length) return map;
    const rows: { playlistId: number; count: number; posters: string[] }[] =
      await this.dataSource.query(
        `
        SELECT c."playlistId" AS "playlistId",
               c.count         AS count,
               COALESCE(p.posters, ARRAY[]::text[]) AS posters
        FROM (
          SELECT pi."playlistId" AS "playlistId", COUNT(*)::int AS count
          FROM playlist_items pi
          JOIN media m ON m.id = pi."mediaId"
          WHERE pi."playlistId" = ANY($1)
            AND m."libraryId" = ANY($2)
          GROUP BY pi."playlistId"
        ) c
        LEFT JOIN (
          -- One poster per distinct media (a series counts once, not once per
          -- episode), ordered by its first position, capped at 4 for the mosaic.
          SELECT "playlistId", (ARRAY_AGG(poster ORDER BY minpos))[1:4] AS posters
          FROM (
            SELECT pi."playlistId" AS "playlistId",
                   m."posterUrl"   AS poster,
                   MIN(pi."position") AS minpos
            FROM playlist_items pi
            JOIN media m ON m.id = pi."mediaId"
            WHERE pi."playlistId" = ANY($1)
              AND m."libraryId" = ANY($2)
              AND m."posterUrl" IS NOT NULL
            GROUP BY pi."playlistId", m."posterUrl"
          ) d
          GROUP BY "playlistId"
        ) p ON p."playlistId" = c."playlistId"
        `,
        [playlistIds, accessibleLibraryIds],
      );
    for (const r of rows) {
      map.set(r.playlistId, { count: r.count, posters: r.posters ?? [] });
    }
    return map;
  }
}
