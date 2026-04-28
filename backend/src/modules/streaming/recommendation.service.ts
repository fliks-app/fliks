/**
 * # RecommendationService
 *
 * Genre-based "Recommendations" engine for the home page.
 *
 * ## Algorithm
 *
 * 1. **Watch history**: load the user's last 15 completed PlaybackStates,
 *    deduplicate by mediaId → keep the 10 most recent unique media.
 *
 * 2. **Genre profile**: for each watched media at rank `r` (0 = most recent),
 *    assign weight `1 / (r + 1)` to each of its genres. This gives a
 *    weighted frequency map: `{ "Action": 1.83, "Sci-Fi": 0.7, … }`.
 *    The genre source map tracks which watched title contributed each genre
 *    (used for the "because" label).
 *
 * 3. **Candidates**: load every media in the user's accessible libraries that
 *    has genres AND hasn't been watched (not in any PlaybackState for this
 *    user — not just completed, also in-progress, to avoid recommending
 *    something the user already started).
 *
 * 4. **Scoring**: for each candidate, sum the genre weights of matching genres.
 *    Track the highest-weighted genre to determine the "because" title.
 *
 * 5. **Output**: sort by score DESC, return top 15 with media summary +
 *    `becauseTitle` (the watched title that best explains the recommendation).
 *
 * ## Endpoint
 *
 * `GET /api/playback/recommendations` — user-scoped, returns
 * `RecommendationItem[]`. Library ACL applied on candidates.
 *
 * ## Limitations
 *
 * - Genres only — no cast/crew/keywords/TMDB-similar enrichment (yet).
 * - Cold start: no recommendations until the user has watched ≥ 1 media
 *   with genre data.
 * - Series completion: counts any completed PlaybackState (episode-level),
 *   not full series completion.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Media } from '../media/entities/media.entity';
import { PlaybackState } from './entities/playback-state.entity';
import { RecommendationDismissal } from './entities/recommendation-dismissal.entity';

export interface RecommendationItem {
  media: {
    id: number;
    title: string;
    type: string;
    year: number;
    posterUrl: string | null;
    genres: string[];
  };
  becauseTitle: string;
  score: number;
}

@Injectable()
export class RecommendationService {
  constructor(
    @InjectRepository(PlaybackState)
    private readonly playbackRepo: Repository<PlaybackState>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(RecommendationDismissal)
    private readonly dismissalRepo: Repository<RecommendationDismissal>,
  ) {}

  /**
   * Persist a user-explicit "don't recommend this again" gesture. Idempotent
   * — duplicate calls collapse on the unique (userId, mediaId) index.
   */
  async dismiss(userId: number, mediaId: number): Promise<void> {
    await this.dismissalRepo
      .createQueryBuilder()
      .insert()
      .values({ userId, mediaId })
      .orIgnore()
      .execute();
  }

  async getRecommendations(
    userId: number,
    accessibleLibraryIds?: number[] | null,
  ): Promise<RecommendationItem[]> {
    // 1. Recently completed media
    const recentStates = await this.playbackRepo.find({
      where: { user: { id: userId }, completed: true },
      order: { lastPlayedAt: 'DESC' },
      take: 15,
      relations: ['media'],
    });

    // Deduplicate by mediaId (keep most recent)
    const seen = new Set<number>();
    const recentMedia: { media: Media; rank: number }[] = [];
    let rank = 0;
    for (const ps of recentStates) {
      if (!ps.media?.genres?.length) continue;
      if (seen.has(ps.media.id)) continue;
      seen.add(ps.media.id);
      recentMedia.push({ media: ps.media, rank });
      rank++;
      if (recentMedia.length >= 10) break;
    }

    if (!recentMedia.length) return [];

    // 2. Build genre weight map (most recent = highest weight)
    const genreWeights = new Map<string, number>();
    const genreSource = new Map<string, string>();
    for (const { media: m, rank: r } of recentMedia) {
      const weight = 1 / (r + 1);
      for (const g of m.genres) {
        genreWeights.set(g, (genreWeights.get(g) ?? 0) + weight);
        if (!genreSource.has(g) || r === 0) genreSource.set(g, m.title);
      }
    }

    // 3. Load all unwatched + non-dismissed media
    const excludedIds = new Set(recentMedia.map((r) => r.media.id));
    const allStates: { mediaId: number }[] = await this.playbackRepo
      .createQueryBuilder('ps')
      .select('DISTINCT ps."mediaId"', 'mediaId')
      .where('ps."userId" = :userId', { userId })
      .getRawMany();
    for (const row of allStates) excludedIds.add(row.mediaId);
    const dismissed = await this.dismissalRepo
      .createQueryBuilder('d')
      .select('d."mediaId"', 'mediaId')
      .where('d."userId" = :userId', { userId })
      .getRawMany<{ mediaId: number }>();
    for (const row of dismissed) excludedIds.add(row.mediaId);

    const qb = this.mediaRepo
      .createQueryBuilder('m')
      .select([
        'm.id',
        'm.title',
        'm.type',
        'm.year',
        'm.posterUrl',
        'm.genres',
      ])
      .where('m.genres IS NOT NULL')
      .andWhere("m.genres != '[]'::jsonb");

    if (excludedIds.size > 0) {
      qb.andWhere('m.id NOT IN (:...excludedIds)', {
        excludedIds: [...excludedIds],
      });
    }

    if (accessibleLibraryIds !== undefined && accessibleLibraryIds !== null) {
      if (accessibleLibraryIds.length === 0) return [];
      qb.andWhere('m."libraryId" IN (:...libs)', {
        libs: accessibleLibraryIds,
      });
    }

    const candidates = await qb.getMany();

    // 4. Score each candidate
    const scored: { media: Media; score: number; topGenre: string }[] = [];
    for (const c of candidates) {
      if (!c.genres?.length) continue;
      let total = 0;
      let topGenre = '';
      let topWeight = 0;
      for (const g of c.genres) {
        const w = genreWeights.get(g) ?? 0;
        total += w;
        if (w > topWeight) {
          topWeight = w;
          topGenre = g;
        }
      }
      if (total > 0) {
        scored.push({ media: c, score: total, topGenre });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, 15).map((s) => ({
      media: {
        id: s.media.id,
        title: s.media.title,
        type: s.media.type,
        year: s.media.year,
        posterUrl: s.media.posterUrl,
        genres: s.media.genres,
      },
      becauseTitle: genreSource.get(s.topGenre) ?? recentMedia[0].media.title,
      score: Math.round(s.score * 100) / 100,
    }));
  }
}
