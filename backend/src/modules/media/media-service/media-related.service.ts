import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Media } from '../entities/media.entity';
import { MediaCrew } from '../entities/media-crew.entity';
import { MediaType } from '../../../common/enums';

export interface RelatedMediaItem {
  id: number;
  title: string;
  year: number;
  posterUrl: string | null;
  rating: number | null;
  genres: string[];
  /** False when nothing is on disk yet, so the card can flag it as missing. */
  hasFile: boolean;
}

export interface MediaCollection {
  id: number;
  name: string;
  /** Every other title of the collection held in the same library, oldest first. */
  items: RelatedMediaItem[];
}

/** Keywords are the sharpest signal TMDB gives: two of them beat any genre pair. */
const W_KEYWORD = 1.6;
const KEYWORD_CAP = 4.8;
const W_GENRE = 2.5;
const W_DIRECTOR = 2;
const W_YEAR = 0.5;
/** Two decades apart contributes nothing. */
const YEAR_SPAN = 20;
/** Below this a title only shares one broad genre — noise, not a suggestion. */
const MIN_SCORE = 1;

/** Exported for the spec: the ranking is the whole feature. */
export function scoreSimilarity(
  source: Pick<Media, 'genres' | 'year' | 'metadata'>,
  candidate: Pick<Media, 'genres' | 'year' | 'metadata'>,
  sameDirector: boolean,
): number {
  let score = 0;

  const keywordHits = sharedCount(
    source.metadata?.keywords ?? [],
    candidate.metadata?.keywords ?? [],
  );
  score += Math.min(keywordHits * W_KEYWORD, KEYWORD_CAP);

  score += cosineOverlap(source.genres ?? [], candidate.genres ?? []) * W_GENRE;

  if (sameDirector) score += W_DIRECTOR;

  if (source.year && candidate.year) {
    const gap = Math.abs(source.year - candidate.year);
    score += Math.max(0, 1 - gap / YEAR_SPAN) * W_YEAR;
  }

  return score;
}

function toItem(media: Media): RelatedMediaItem {
  return {
    id: media.id,
    title: media.title,
    year: media.year,
    posterUrl: media.posterUrl ?? null,
    rating: media.rating ?? null,
    genres: media.genres ?? [],
    hasFile: ((media as Media & { fileCount?: number }).fileCount ?? 0) > 0,
  };
}

function sharedCount(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const set = new Set(a.map((v) => v.toLowerCase()));
  return b.filter((v) => set.has(v.toLowerCase())).length;
}

/**
 * Overlap normalized by both list lengths, so a title tagged with eight
 * genres doesn't outrank a tighter match just by casting a wider net.
 */
function cosineOverlap(a: string[], b: string[]): number {
  const shared = sharedCount(a, b);
  return shared ? shared / Math.sqrt(a.length * b.length) : 0;
}

/**
 * Related-titles queries for the movie page, both restricted to what the
 * library actually holds: the collection the movie belongs to, and a
 * "more like this" list.
 *
 * Similarity scores candidates on the signals the local metadata carries —
 * keywords, genres, director, release year — rather than asking the provider
 * for its own similar list, which mostly returns titles nobody here owns.
 * Collection members are excluded: they have their own section, and a saga
 * listed twice on one page reads as a bug.
 *
 * The SQL pre-filter keeps candidates to those sharing at least one signal,
 * so a large library isn't hydrated in full on every movie page.
 */
@Injectable()
export class MediaRelatedService {
  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaCrew)
    private readonly crewRepo: Repository<MediaCrew>,
  ) {}

  async findSimilar(mediaId: number, limit = 12): Promise<RelatedMediaItem[]> {
    const source = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['metadata'],
    });
    if (!source) throw new NotFoundException(`Media #${mediaId} not found`);
    if (source.type !== MediaType.MOVIE || !source.libraryId) return [];

    const genres = source.genres ?? [];
    const keywords = source.metadata?.keywords ?? [];
    const directors = await this.directorPersonIds(mediaId);
    const sameDirectorIds = directors.length
      ? await this.mediaIdsByDirector(directors, mediaId)
      : [];

    if (!genres.length && !keywords.length && !sameDirectorIds.length) return [];

    const candidatesQb = this.mediaRepo
      .createQueryBuilder('m')
      .leftJoin('m.metadata', 'meta')
      .addSelect(['meta.id', 'meta.keywords'])
      .loadRelationCountAndMap('m.fileCount', 'm.files')
      .where('m.libraryId = :libraryId', { libraryId: source.libraryId })
      .andWhere('m.type = :type', { type: MediaType.MOVIE })
      .andWhere('m.id != :mediaId', { mediaId })
      .andWhere(
        new Brackets((w) => {
          // `1 = 0` keeps the brackets valid whichever signals are missing.
          w.where('1 = 0');
          if (genres.length) {
            w.orWhere('jsonb_exists_any(m.genres, ARRAY[:...genres])', {
              genres,
            });
          }
          if (keywords.length) {
            w.orWhere('jsonb_exists_any(meta.keywords, ARRAY[:...keywords])', {
              keywords,
            });
          }
          if (sameDirectorIds.length) {
            w.orWhere('m.id IN (:...sameDirectorIds)', { sameDirectorIds });
          }
        }),
      );

    if (source.tmdbCollectionId != null) {
      candidatesQb.andWhere(
        '(m.tmdbCollectionId IS NULL OR m.tmdbCollectionId != :sourceCollectionId)',
        { sourceCollectionId: source.tmdbCollectionId },
      );
    }

    const candidates = await candidatesQb.getMany();
    const directorMatches = new Set(sameDirectorIds);

    return candidates
      .map((media) => ({
        media,
        score: scoreSimilarity(source, media, directorMatches.has(media.id)),
      }))
      .filter((c) => c.score >= MIN_SCORE)
      .sort(
        (a, b) =>
          b.score - a.score || (b.media.rating ?? 0) - (a.media.rating ?? 0),
      )
      .slice(0, limit)
      .map(({ media }) => toItem(media));
  }

  /**
   * The rest of the movie's TMDB collection, as held in the same library.
   * Null when the movie belongs to no collection or owns it alone — the
   * page has nothing to show either way.
   */
  async findCollection(mediaId: number): Promise<MediaCollection | null> {
    const source = await this.mediaRepo.findOne({ where: { id: mediaId } });
    if (!source) throw new NotFoundException(`Media #${mediaId} not found`);
    if (source.tmdbCollectionId == null || !source.libraryId) return null;

    const items = await this.mediaRepo
      .createQueryBuilder('m')
      .loadRelationCountAndMap('m.fileCount', 'm.files')
      .where('m.libraryId = :libraryId', { libraryId: source.libraryId })
      .andWhere('m.tmdbCollectionId = :collectionId', {
        collectionId: source.tmdbCollectionId,
      })
      .andWhere('m.id != :mediaId', { mediaId })
      .orderBy('m.releaseDate', 'ASC', 'NULLS LAST')
      .addOrderBy('m.year', 'ASC', 'NULLS LAST')
      .getMany();

    if (!items.length) return null;
    return {
      id: source.tmdbCollectionId,
      name: source.tmdbCollectionName ?? '',
      items: items.map(toItem),
    };
  }

  private async directorPersonIds(mediaId: number): Promise<number[]> {
    const crew = await this.crewRepo.find({
      where: { media: { id: mediaId }, job: 'Director' },
      relations: ['person'],
    });
    return crew.map((c) => c.person.id);
  }

  private async mediaIdsByDirector(
    personIds: number[],
    excludeMediaId: number,
  ): Promise<number[]> {
    const rows = await this.crewRepo
      .createQueryBuilder('crew')
      .select('crew."mediaId"', 'mediaId')
      .where('crew."personId" IN (:...personIds)', { personIds })
      .andWhere('crew.job = :job', { job: 'Director' })
      .andWhere('crew."mediaId" != :excludeMediaId', { excludeMediaId })
      .getRawMany<{ mediaId: number }>();
    return [...new Set(rows.map((r) => r.mediaId))];
  }
}
