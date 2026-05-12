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
 * 4. **Scoring**: for each candidate, sum the genre weights of matching
 *    genres, then normalize by `sqrt(candidate.genres.length)`. The
 *    normalization removes a series-vs-movie bias: TMDB tags series with
 *    4-5 genres on average and movies with 2-3, so the raw sum systematically
 *    over-rewarded series. Track the highest-weighted matching genre to
 *    determine the "because" title.
 *
 * 5. **Stratification**: cap each media type at 10 of the 15 final slots so
 *    one type can't crowd out the other. The cap is lifted in a fill pass
 *    when only one type produced enough candidates, so we never return fewer
 *    items just to enforce diversity.
 *
 * 6. **Output**: sort by score DESC, apply the cap, return top 15 with media
 *    summary + `becauseTitle` (the watched title that best explains the
 *    recommendation).
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

import { Injectable, Logger } from '@nestjs/common';
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

  /**
   * Drop every dismissal for the user — clean slate, all previously hidden
   * recommendations become eligible again. Returns the number of rows
   * removed so the UI can confirm the action.
   */
  async resetDismissals(userId: number): Promise<{ removed: number }> {
    const result = await this.dismissalRepo.delete({ userId });
    return { removed: result.affected ?? 0 };
  }

  /** Number of currently dismissed recommendations for the user. */
  async countDismissals(userId: number): Promise<number> {
    return this.dismissalRepo.count({ where: { userId } });
  }

  async getRecommendations(
    userId: number,
    accessibleLibraryIds: number[],
    /** Override the default 15-item cap. Capped server-side at 50 by
     *  the controller, so this only widens — passing larger values has
     *  no effect once the cap is hit. */
    limit?: number,
  ): Promise<RecommendationItem[]> {
    if (accessibleLibraryIds.length === 0) return [];
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

    qb.andWhere('m."libraryId" IN (:...libs)', { libs: accessibleLibraryIds });

    const candidates = await qb.getMany();

    // 4. Score each candidate.
    //
    // Normalize by `sqrt(genres.length)` (TF-IDF-style): a raw sum rewards
    // candidates that simply carry more genres, which biased the output
    // toward series — they typically tag 4-5 genres against a movie's 2-3,
    // so any partial match gave them more points. Sqrt softens the breadth
    // penalty (vs a pure average) while still removing the "more genres
    // beats better fit" effect.
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
        scored.push({
          media: c,
          score: total / Math.sqrt(c.genres.length),
          topGenre,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    // 5. Stratify by media type so a single type can't crowd out the other.
    // Cap each type at 10 of the 15 slots — guarantees ≥ 5 of the other
    // type when both exist in the candidate pool. If only one type has
    // recommendations, the cap is lifted in the fill pass so we don't
    // return fewer than 15 items just to enforce diversity.
    const TOTAL = limit ?? 15;
    // Keep the per-type cap proportional so a wider window still
    // guarantees a real mix between movies + series.
    const PER_TYPE_CAP = Math.max(10, Math.ceil(TOTAL * 0.7));
    const top: typeof scored = [];
    const overflow: typeof scored = [];
    const perType: Record<string, number> = {};
    for (const s of scored) {
      if (top.length >= TOTAL) break;
      const t = s.media.type;
      if ((perType[t] ?? 0) >= PER_TYPE_CAP) {
        overflow.push(s);
        continue;
      }
      top.push(s);
      perType[t] = (perType[t] ?? 0) + 1;
    }
    for (const s of overflow) {
      if (top.length >= TOTAL) break;
      top.push(s);
    }

    return top.map((s) => ({
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
