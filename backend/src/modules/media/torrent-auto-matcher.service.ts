import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Media } from './entities/media.entity';
import { Season } from './entities/season.entity';
import { Episode } from './entities/episode.entity';
import { MediaType } from '../../common/enums';
import {
  ExtractedRelease,
  extractMediaTitle,
} from '../../common/release-parsing';

export interface AutoMatchResult {
  media: Media;
  season?: Season | null;
  episode?: Episode | null;
  /**
   * Reason the match succeeded. `'series-episode'` for single episodes,
   * `'series-season'` for season packs, `'movie'` for movies. Useful in
   * logs and for the caller to decide which row shape to persist.
   */
  matchedKind: 'series-episode' | 'series-season' | 'movie';
}

/**
 * Identifies a `Media` (and where possible a `Season` + `Episode`) from
 * a raw torrent / file name, without going through `DownloadHistory`.
 *
 * Used by the orphan-torrent recovery flow in `CompletionService` so a
 * torrent appearing in qBit with no history row (added manually, hand-
 * imported from another tool, or surviving a database wipe) gets
 * bound back to its media automatically — instead of staying invisible
 * to the rest of the system forever.
 *
 * Algorithm:
 *   1. {@link extractMediaTitle} extracts \`{ searchKey, year, season,
 *      episode, kind }\` from the name.
 *   2. \`searchKey\` is normalised alphanumerics-only — we query the
 *      DB with the SAME normalisation on the candidate titles so dot /
 *      space / punctuation drift doesn't kill the lookup.
 *   3. Series path: load monitored series whose normalised title or
 *      \`alternativeTitles\` entry matches. If multiple → ambiguous,
 *      give up (the user can manually link). If one + the release
 *      carries a season number, walk the seasons + episodes to bind.
 *   4. Movie path: same name lookup scoped to \`type=movie\`. The year
 *      acts as a tiebreaker when several candidates share a title.
 *
 * Returns null on any ambiguity — the orphan recovery flow then leaves
 * the torrent unlinked and surfaces it for manual binding.
 */
@Injectable()
export class TorrentAutoMatcher {
  private readonly log = new Logger(TorrentAutoMatcher.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
  ) {}

  async tryMatch(torrentName: string): Promise<AutoMatchResult | null> {
    if (!torrentName) return null;
    const parsed = extractMediaTitle(torrentName);
    if (!parsed.searchKey) return null;

    if (parsed.kind === 'series' || parsed.season !== null) {
      return this.matchSeries(parsed);
    }
    if (parsed.kind === 'movie' || parsed.year !== null) {
      return this.matchMovie(parsed);
    }
    // Last-ditch: try series first then movie. Some malformed names
    // ("Some Show Disc 1") have no S/E and no year — they're rare and
    // not worth a separate codepath.
    return (
      (await this.matchSeries(parsed)) ?? (await this.matchMovie(parsed))
    );
  }

  private async matchSeries(
    parsed: ExtractedRelease,
  ): Promise<AutoMatchResult | null> {
    const series = await this.lookupMedia(parsed, MediaType.SERIES);
    if (!series) return null;

    // Bind season if the release carries one and the series has it.
    if (parsed.season === null) {
      return { media: series, matchedKind: 'series-season' };
    }
    const season = await this.seasonRepo.findOne({
      where: { media: { id: series.id }, seasonNumber: parsed.season },
    });
    if (!season) {
      // The series matches but the season number doesn't exist on it
      // — likely a different series sharing the title. Bail rather
      // than associate against the wrong one.
      this.log.debug?.(
        `TorrentAutoMatcher: series "${series.title}" matched but has no season ${parsed.season} — refusing`,
      );
      return null;
    }

    // Season pack vs single episode.
    if (parsed.isFullSeason || parsed.episode === null) {
      return { media: series, season, matchedKind: 'series-season' };
    }
    const episode = await this.episodeRepo.findOne({
      where: {
        season: { id: season.id },
        episodeNumber: parsed.episode,
      },
    });
    if (!episode) {
      // Episode number out of range — same caution as above. Fall back
      // to season-only binding so the row still carries useful info.
      return { media: series, season, matchedKind: 'series-season' };
    }
    return {
      media: series,
      season,
      episode,
      matchedKind: 'series-episode',
    };
  }

  private async matchMovie(
    parsed: ExtractedRelease,
  ): Promise<AutoMatchResult | null> {
    const movie = await this.lookupMedia(parsed, MediaType.MOVIE);
    return movie ? { media: movie, matchedKind: 'movie' } : null;
  }

  /**
   * Title-based media lookup. SQL pre-filter compares the alphanumeric-
   * stripped form of every known title source (\`title\`, \`originalTitle\`,
   * \`alternativeTitles\`) against the candidate's \`searchKey\`. We can't
   * \`ILIKE '%title%'\` directly because:
   *  - A French-localised media (\`title = "Margo a des problèmes d'argent"\`)
   *    with the English original (\`originalTitle = "Margo's Got Money
   *    Troubles"\`) wouldn't match a release named after the English title.
   *  - Punctuation in either the torrent name or the stored title (an
   *    apostrophe, a colon, dot separators) used to block the substring
   *    match. Stripping non-alphanumerics on both sides removes the drift.
   *
   * Result set is then narrowed in JS using the same normalisation. Year
   * is a tiebreaker when multiple candidates remain.
   */
  private async lookupMedia(
    parsed: ExtractedRelease,
    type: MediaType,
  ): Promise<Media | null> {
    if (!parsed.searchKey) return null;
    const candidates = await this.mediaRepo
      .createQueryBuilder('m')
      .where('m.type = :type', { type })
      .andWhere(
        `(
          regexp_replace(LOWER(m.title), '[^a-z0-9]+', '', 'g') = :key
          OR regexp_replace(LOWER(COALESCE(m."originalTitle", '')), '[^a-z0-9]+', '', 'g') = :key
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(m."alternativeTitles") alt
            WHERE regexp_replace(LOWER(alt), '[^a-z0-9]+', '', 'g') = :key
          )
        )`,
        { key: parsed.searchKey, type },
      )
      .take(50)
      .getMany();

    const norm = (s: string | undefined | null): string =>
      (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const matching = candidates.filter((m) => {
      const candidateKeys = [
        norm(m.title),
        norm(m.originalTitle),
        ...(m.alternativeTitles ?? []).map(norm),
      ].filter(Boolean);
      return candidateKeys.includes(parsed.searchKey);
    });

    if (matching.length === 0) return null;
    if (matching.length === 1) return matching[0];

    // Multiple candidates — the year is our only tiebreaker.
    if (parsed.year !== null) {
      const byYear = matching.filter((m) => m.year === parsed.year);
      if (byYear.length === 1) return byYear[0];
    }
    this.log.warn(
      `TorrentAutoMatcher: ${matching.length} ${type} candidates for "${parsed.title}"${parsed.year ? ` (${parsed.year})` : ''} — refusing to guess`,
    );
    return null;
  }
}
