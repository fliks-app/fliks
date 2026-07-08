import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Playlist } from './entities/playlist.entity';
import { PlaylistItem } from './entities/playlist-item.entity';
import { PlaylistShare } from './entities/playlist-share.entity';
import { Media } from '../media/entities/media.entity';
import { User } from '../users/entities/user.entity';
import { LibrariesService } from '../libraries/libraries.service';
import { PlaylistShareRole } from '../../common/enums';
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
  media: Media;
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
    return items
      .filter((i) => byId.has(i.mediaId))
      .map((i) => ({
        itemId: i.id,
        position: i.position,
        addedById: i.addedById,
        media: byId.get(i.mediaId) as Media,
      }));
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

  async addItem(
    user: User,
    playlistId: number,
    dto: AddPlaylistItemDto,
  ): Promise<PlaylistItem> {
    await this.assertRole(user, playlistId, PlaylistShareRole.EDITOR);

    // Only media the caller can see may be added.
    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    const media = await this.mediaRepo.findOne({
      where: {
        id: dto.mediaId,
        library: { id: In(accessible.length ? accessible : [-1]) },
      },
    });
    if (!media) throw new NotFoundException(`Media #${dto.mediaId} not found`);

    const existing = await this.itemRepo.findOne({
      where: { playlist: { id: playlistId }, media: { id: dto.mediaId } },
    });
    if (existing) throw new BadRequestException('errors.media_already_in_playlist');

    const max = await this.itemRepo
      .createQueryBuilder('i')
      .select('MAX(i.position)', 'max')
      .where('i."playlistId" = :pid', { pid: playlistId })
      .getRawOne<{ max: number | null }>();
    const position = max?.max != null ? Number(max.max) + 1 : 0;

    try {
      return await this.itemRepo.save(
        this.itemRepo.create({
          playlist: { id: playlistId } as Playlist,
          media: { id: dto.mediaId } as Media,
          addedBy: { id: user.id } as User,
          position,
        }),
      );
    } catch (err) {
      // Unique(playlist, media): a concurrent add raced past the pre-check —
      // surface the same clean 400 rather than a raw DB error.
      if ((err as { code?: string }).code === '23505') {
        throw new BadRequestException('errors.media_already_in_playlist');
      }
      throw err;
    }
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
        SELECT pi."playlistId" AS "playlistId",
               COUNT(*)::int    AS count,
               COALESCE(
                 (ARRAY_AGG(m."posterUrl" ORDER BY pi."position")
                  FILTER (WHERE m."posterUrl" IS NOT NULL))[1:4],
                 ARRAY[]::text[]
               ) AS posters
        FROM playlist_items pi
        JOIN media m ON m.id = pi."mediaId"
        WHERE pi."playlistId" = ANY($1)
          AND m."libraryId" = ANY($2)
        GROUP BY pi."playlistId"
        `,
        [playlistIds, accessibleLibraryIds],
      );
    for (const r of rows) {
      map.set(r.playlistId, { count: r.count, posters: r.posters ?? [] });
    }
    return map;
  }
}
