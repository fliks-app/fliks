import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Like } from './entities/like.entity';
import { Media } from '../media/entities/media.entity';
import { User } from '../users/entities/user.entity';
import { LibrariesService } from '../libraries/libraries.service';

export interface LikeTarget {
  mediaId: number;
  seasonId?: number;
  episodeId?: number;
}

/** Which of a media's parts the caller likes (drives the detail-page hearts). */
export interface LikeState {
  media: boolean;
  seasonIds: number[];
  episodeIds: number[];
}

/** A liked entry rendered as a card (movie, season or episode). */
export interface LikedItem {
  mediaId: number;
  mediaType: string;
  title: string;
  posterUrl: string | null;
  fanartUrl: string | null;
  seasonId: number | null;
  episodeId: number | null;
  label: string | null;
  stillUrl: string | null;
}

@Injectable()
export class LikesService {
  constructor(
    @InjectRepository(Like)
    private readonly likeRepo: Repository<Like>,
    private readonly libraries: LibrariesService,
  ) {}

  /** The caller's own liked content, scoped to their library access. */
  async myLikes(user: User, libraryId?: number): Promise<LikedItem[]> {
    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    return this.listLikes(user.id, accessible, { libraryId });
  }

  async like(user: User, t: LikeTarget): Promise<void> {
    await this.likeRepo
      .createQueryBuilder()
      .insert()
      .values({
        user: { id: user.id } as User,
        media: { id: t.mediaId } as Media,
        season: t.seasonId ? ({ id: t.seasonId } as any) : null,
        episode: t.episodeId ? ({ id: t.episodeId } as any) : null,
      })
      .orIgnore() // ON CONFLICT DO NOTHING — idempotent per partial unique index
      .execute();
  }

  async unlike(user: User, t: LikeTarget): Promise<void> {
    const qb = this.likeRepo
      .createQueryBuilder()
      .delete()
      .where('"userId" = :u AND "mediaId" = :m', { u: user.id, m: t.mediaId });
    if (t.seasonId) qb.andWhere('"seasonId" = :s', { s: t.seasonId });
    else qb.andWhere('"seasonId" IS NULL');
    if (t.episodeId) qb.andWhere('"episodeId" = :e', { e: t.episodeId });
    else qb.andWhere('"episodeId" IS NULL');
    await qb.execute();
  }

  /** Keys (`mediaId:seasonId:episodeId`) the user likes among `mediaIds`. */
  async likedKeys(userId: number, mediaIds: number[]): Promise<Set<string>> {
    if (!mediaIds.length) return new Set();
    const rows: { mediaId: number; seasonId: number | null; episodeId: number | null }[] =
      await this.likeRepo
        .createQueryBuilder('l')
        .select('l.mediaId', 'mediaId')
        .addSelect('l.seasonId', 'seasonId')
        .addSelect('l.episodeId', 'episodeId')
        .where('l."userId" = :u AND l."mediaId" IN (:...mediaIds)', {
          u: userId,
          mediaIds,
        })
        .getRawMany();
    return new Set(
      rows.map((r) => `${r.mediaId}:${r.seasonId ?? ''}:${r.episodeId ?? ''}`),
    );
  }

  /** The caller's likes on one media (movie flag + liked season/episode ids). */
  async stateFor(user: User, mediaId: number): Promise<LikeState> {
    const rows: { seasonId: number | null; episodeId: number | null }[] =
      await this.likeRepo
        .createQueryBuilder('l')
        .select('l.seasonId', 'seasonId')
        .addSelect('l.episodeId', 'episodeId')
        .where('l."userId" = :u AND l."mediaId" = :m', { u: user.id, m: mediaId })
        .getRawMany();
    return {
      media: rows.some((r) => r.seasonId == null && r.episodeId == null),
      seasonIds: rows.filter((r) => r.seasonId != null).map((r) => r.seasonId!),
      episodeIds: rows.filter((r) => r.episodeId != null).map((r) => r.episodeId!),
    };
  }

  /**
   * A user's liked content as cards, newest first, scoped to `accessibleLibraryIds`
   * (pass the VIEWER's own ids). Used for "my favourites" (self) and the public
   * profile "likes" section (target user + viewer ACL).
   */
  async listLikes(
    userId: number,
    accessibleLibraryIds: number[],
    opts: { libraryId?: number; limit?: number } = {},
  ): Promise<LikedItem[]> {
    if (!accessibleLibraryIds.length) return [];
    const likes = await this.likeRepo.find({
      where: { user: { id: userId } },
      relations: ['media', 'season', 'episode', 'episode.season'],
      order: { createdAt: 'DESC' },
      take: opts.limit ?? 60,
    });
    const items: LikedItem[] = [];
    for (const l of likes) {
      const m = l.media;
      if (!m || !accessibleLibraryIds.includes(m.libraryId as number)) continue;
      if (opts.libraryId && m.libraryId !== opts.libraryId) continue;
      const season = l.season ?? l.episode?.season ?? null;
      const label = l.episode
        ? `S${season?.seasonNumber ?? '?'}E${l.episode.episodeNumber}` +
          (l.episode.title ? ` · ${l.episode.title}` : '')
        : l.season
          ? `${m.title} · S${l.season.seasonNumber}`
          : null;
      items.push({
        mediaId: m.id,
        mediaType: m.type,
        title: m.title,
        posterUrl: m.posterUrl,
        fanartUrl: m.fanartUrl,
        seasonId: l.seasonId,
        episodeId: l.episodeId,
        label,
        stillUrl: l.episode?.stillUrl ?? null,
      });
    }
    return items;
  }
}
