import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Media } from './entities/media.entity';
import { Season } from './entities/season.entity';
import { Episode } from './entities/episode.entity';
import { MediaFile } from './entities/media-file.entity';
import { MediaType } from '../../common/enums';
import { onDiskSql } from './episode-coverage.util';
import { rankFromQualityString } from '../../common/release-scoring';
import { AutoGrabPipelineService } from './auto-grab-pipeline.service';

export interface MovieTarget {
  media: Media;
  files: { quality?: string | null }[];
}

export interface EpisodeTarget {
  media: Media;
  season: Season;
  episode: Episode;
  /** `[]` when the episode has no file (missing), one entry with the best
   *  quality on disk when it is an upgrade candidate. */
  files: { quality: string | null }[];
}

export interface SeasonPackTarget {
  media: Media;
  season: Season;
  /** The missing/upgradable episodes of that season — at least two. */
  episodes: Episode[];
  /** `[]` while any covered episode is still missing; otherwise one entry
   *  carrying the WEAKEST quality on disk, so a season at cutoff resolves to
   *  `skip` rather than an unbounded "missing" grab. */
  files: { quality: string | null }[];
  /** Every episode of the season, not just the missing ones — drives the
   *  pack's runtime for the size check. */
  totalEpisodeCount: number;
}

/**
 * SearchMissing candidate enumeration: which movies/episodes need a search,
 * and how missing/upgradable episodes group into season packs. Extracted
 * from SchedulerService so the query + filter logic can be exercised without
 * the cron/torznab/qBittorrent machinery around it.
 */
/** `{at-cutoff: 24, upgrades-disabled: 2}` → `"24 at cutoff, 2 upgrades disabled"`. */
function describeExclusions(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${reason.replace(/-/g, ' ')}`)
    .join(', ');
}

@Injectable()
export class AcquisitionCandidatesService {
  private readonly log = new Logger(AcquisitionCandidatesService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    private readonly autoGrab: AutoGrabPipelineService,
  ) {}

  async listMovieTargets(mediaIds?: number[], quiet = false): Promise<MovieTarget[]> {
    const qb = this.mediaRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.qualityProfile', 'qp')
      .leftJoinAndSelect('m.languageProfile', 'lp')
      .leftJoinAndSelect('m.files', 'f')
      .where('m.monitored = true')
      .andWhere('m.type = :type', { type: MediaType.MOVIE })
      .andWhere('(f.id IS NULL OR qp."upgradeAllowed" = true)');
    if (mediaIds?.length) {
      qb.andWhere('m.id IN (:...mediaIds)', { mediaIds });
    }
    const allCandidates = await qb.getMany();
    const candidates: Media[] = [];
    const excluded: string[] = [];
    for (const m of allCandidates) {
      const reason = this.autoGrab.searchExclusionReason(m, m.files ?? []);
      if (reason) excluded.push(reason);
      else candidates.push(m);
    }
    if (excluded.length && !quiet) {
      this.log.log(
        `SearchMissing[movies]: ${candidates.length} need a search, ${excluded.length} excluded (${describeExclusions(excluded)})`,
      );
    }

    return candidates.map((media) => ({ media, files: media.files ?? [] }));
  }

  async listEpisodeTargets(mediaIds?: number[], quiet = false): Promise<EpisodeTarget[]> {
    const today = new Date().toISOString().slice(0, 10);

    const qb = this.episodeRepo
      .createQueryBuilder('ep')
      .innerJoin('ep.season', 'season')
      .innerJoin('season.media', 'media')
      .leftJoinAndSelect('media.qualityProfile', 'qp')
      .leftJoinAndSelect('media.languageProfile', 'lp')
      .where('media.monitored = true')
      .andWhere('media.type = :type', { type: MediaType.SERIES })
      .andWhere('season.monitored = true')
      .andWhere('ep.monitored = true')
      .andWhere('ep.airDate IS NOT NULL')
      .andWhere('ep.airDate <= :today', { today })
      // Missing → search when the content isn't on disk (coverage, so multi-
      // episode shadowed episodes aren't re-searched). Upgrade → only episodes
      // with their OWN file (hasFile); a shadowed episode upgrades via its owner.
      .andWhere(
        `(NOT ${onDiskSql('ep')} OR (ep.hasFile = true AND qp."upgradeAllowed" = true))`,
      );
    if (mediaIds?.length) {
      qb.andWhere('media.id IN (:...mediaIds)', { mediaIds });
    }
    let episodes = await qb
      .select([
        'ep.id',
        'ep.episodeNumber',
        'ep.title',
        'ep.airDate',
        'ep.hasFile',
      ])
      .addSelect(['season.id', 'season.seasonNumber', 'season.mediaId'])
      .addSelect([
        'media.id',
        'media.title',
        'media.originalTitle',
        'media.year',
        'media.runtime',
        'media.tvdbId',
        'media.imdbId',
        'media.alternativeTitles',
      ])
      // Profile rows are joined for the upgrade-cutoff WHERE clause AND
      // hydrated on the media entity so AutoGrabPipeline.classifyForSearch
      // doesn't read them as undefined and skip with "no profile".
      .addSelect('qp')
      .addSelect('lp')
      .getMany();

    // Batch-load the linked MediaFile quality for upgrade-candidate episodes
    // so the cutoff comparison runs without an N+1.
    const upgradeEpIds = episodes.filter((e) => e.hasFile).map((e) => e.id);
    const fileQualityByEpId = new Map<number, string>();
    if (upgradeEpIds.length) {
      const fileRows = await this.mediaFileRepo
        .createQueryBuilder('f')
        .select(['f.episodeId AS "episodeId"', 'f.quality AS "quality"'])
        .where('f.episodeId IN (:...ids)', { ids: upgradeEpIds })
        .getRawMany<{ episodeId: number; quality: string }>();
      for (const row of fileRows) {
        // Multiple files per ep: keep the best quality seen.
        const prev = fileQualityByEpId.get(row.episodeId);
        if (!prev) {
          fileQualityByEpId.set(row.episodeId, row.quality);
          continue;
        }
        const prevRank = rankFromQualityString(prev);
        const curRank = rankFromQualityString(row.quality);
        if (curRank > prevRank)
          fileQualityByEpId.set(row.episodeId, row.quality);
      }
    }

    const episodeFiles = (ep: Episode): { quality: string | null }[] =>
      ep.hasFile ? [{ quality: fileQualityByEpId.get(ep.id) ?? null }] : [];

    const filteredEpisodes: Episode[] = [];
    const excluded: string[] = [];
    for (const ep of episodes) {
      const media = (ep as unknown as { season: Season }).season.media as Media;
      const reason = this.autoGrab.searchExclusionReason(media, episodeFiles(ep));
      if (reason) excluded.push(reason);
      else filteredEpisodes.push(ep);
    }
    // The count above only ever saw rows the query returned, so "0 need a search" read as
    // "nothing is missing" when it could equally mean the query never offered the missing
    // episodes. Reporting what the query itself left out is what tells those two apart.
    const ineligible = quiet ? 0 : await this.countIneligibleEpisodes(mediaIds);
    if (!quiet)
      this.log.log(
      `SearchMissing[episodes]: ${filteredEpisodes.length} need a search` +
        (excluded.length ? `, ${excluded.length} excluded (${describeExclusions(excluded)})` : '') +
        (ineligible ? `; ${ineligible} monitored episode(s) not eligible at all (already on disk, unaired, or no air date)` : ''),
    );
    episodes = filteredEpisodes;

    return episodes.map((ep) => {
      const season = (ep as unknown as { season: Season }).season;
      const media = (season as unknown as { media: Media }).media;
      return { media, season, episode: ep, files: episodeFiles(ep) };
    });
  }

  /**
   * Monitored, aired episodes the candidate query itself refuses — content already on disk,
   * or no air date at all. Counted so a run reporting nothing to search says which of the two
   * it is: an operator can act on "47 have no air date", not on silence.
   */
  private async countIneligibleEpisodes(mediaIds?: number[]): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
    const qb = this.episodeRepo
      .createQueryBuilder('ep')
      .innerJoin('ep.season', 'season')
      .innerJoin('season.media', 'media')
      .where('media.monitored = true')
      .andWhere('media.type = :type', { type: MediaType.SERIES })
      .andWhere('season.monitored = true')
      .andWhere('ep.monitored = true')
      .andWhere(
        `(ep."airDate" IS NULL OR ep."airDate" > :today OR ${onDiskSql('ep')})`,
        { today },
      );
    if (mediaIds?.length) qb.andWhere('media.id IN (:...mediaIds)', { mediaIds });
    return qb.getCount();
  }

  async groupIntoSeasonPacks(
    targets: EpisodeTarget[],
  ): Promise<SeasonPackTarget[]> {
    const groups = new Map<
      number,
      { season: Season; media: Media; targets: EpisodeTarget[] }
    >();
    for (const t of targets) {
      const group = groups.get(t.season.id);
      if (group) group.targets.push(t);
      else
        groups.set(t.season.id, {
          season: t.season,
          media: t.media,
          targets: [t],
        });
    }
    const multi = [...groups.values()].filter((g) => g.targets.length >= 2);
    if (!multi.length) return [];

    // Total episode count per season drives the pack's runtime for the size
    // check — a pack covers the whole season, not just the missing episodes.
    const counts = await this.episodeRepo
      .createQueryBuilder('ep')
      .select('ep.seasonId', 'seasonId')
      .addSelect('COUNT(*)', 'cnt')
      .where('ep.seasonId IN (:...ids)', {
        ids: multi.map((g) => g.season.id),
      })
      .groupBy('ep.seasonId')
      .getRawMany<{ seasonId: number; cnt: string }>();
    const episodeCountBySeason = new Map(
      counts.map((c) => [Number(c.seasonId), Number(c.cnt)]),
    );

    return multi.map((group) => {
      // Cutoff gate for the pack. The per-episode path hands each file's
      // quality to classifyForSearch so an at-cutoff episode is skipped; the
      // pack must do the same or it re-grabs whole seasons already at cutoff.
      // A genuinely missing episode keeps the empty-files "missing" mode (grab
      // regardless of upgrade settings); once every covered episode is on disk
      // we pass the weakest existing quality so a season at/above cutoff
      // resolves to 'skip' instead of an unbounded "missing" grab.
      let files: { quality: string | null }[] = [];
      if (group.targets.every((t) => t.files.length > 0)) {
        let weakest: string | null = null;
        let weakestRank = Number.POSITIVE_INFINITY;
        for (const t of group.targets) {
          const q = t.files[0].quality ?? null;
          const r = rankFromQualityString(q);
          if (r < weakestRank) {
            weakestRank = r;
            weakest = q;
          }
        }
        files = [{ quality: weakest }];
      }

      return {
        media: group.media,
        season: group.season,
        episodes: group.targets.map((t) => t.episode),
        files,
        totalEpisodeCount:
          episodeCountBySeason.get(group.season.id) ?? group.targets.length,
      };
    });
  }
}
