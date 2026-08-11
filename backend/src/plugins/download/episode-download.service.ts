import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Media } from '../../modules/media/entities/media.entity';
import { EventsService } from '../../modules/scheduler/events.service';
import { Season } from '../../modules/media/entities/season.entity';
import { Episode } from '../../modules/media/entities/episode.entity';
import { DownloadHistory } from './entities/download-history.entity';
import { buildGrabHistoryRow } from './grab-history.util';
import { onDiskEpisodeNumbers } from '../../modules/media/episode-coverage.util';
import { Indexer } from './indexers/entities/indexer.entity';
import { DownloadClient } from './download-clients/entities/download-client.entity';
import { TorznabService } from './indexers/torznab.service';
import { QbittorrentService } from './download-clients/qbittorrent.service';
import {
  parseReleaseLanguage,
  parseReleaseQuality,
  parseSeasonEpisode,
  matchesSeasonPack,
  resolveUnknownLanguage,
} from '../../common/release-parsing';
import { maxAllowedRank } from '../../common/constants/app-qualities';
import { CustomFormatsService } from '../../modules/profiles/custom-formats.service';
import { ProfilesService } from '../../modules/profiles/profiles.service';
import { QualityDefinitionsService } from '../../modules/profiles/quality-definitions.service';
import { BlocklistService } from '../../modules/blocklist/blocklist.service';
import { InProcessPluginHostClient } from '../../modules/plugins/host/in-process-plugin-host-client';
import { MediaType } from '../../common/enums';
import { QualityProfileItem } from '../../modules/profiles/entities/quality-profile.entity';

import { GrabMovieDto } from './dto/grab-movie.dto';
import {
  ReleaseCandidate,
  ReleaseRejection,
  allowedAudioLanguageIds,
  buildIndexerMinSeeders,
  buildAllowedQualityIds,
  computeRejections,
  computeSizeDeviation,
  detectVideoCodec,
  resolveSearchTitles,
  sortReleasesByRelevance,
  SizeLimits,
} from '../../common/release-scoring';

export interface EpisodeReleaseRow {
  title: string;
  downloadUrl: string;
  qualityId: number;
  qualityName: string;
  rank: number;
  allowed: boolean;
  customFormatScore: number;
  blocklisted: boolean;
  indexerId: number;
  indexerName: string;
  languageId: number;
  languageName: string;
  languageAllowed: boolean;
  size: number;
  seeders: number;
  leechers: number;
  rejections: ReleaseRejection[];
  freeleech: boolean;
  downloadVolumeFactor: number;
  /** True when the release title parses as a full-season pack
   *  (`S01`, `Season 1`, etc. without an episode number). */
  isFullSeason: boolean;
  /** Absolute distance of this release's MB/h from the codec-adjusted
   *  preferred size for its quality, divided by the preferred. 0 when
   *  on target, 0.5 = 50% off. `null` when the quality has no
   *  preferred or the runtime is unknown. Used by the sort to nudge
   *  on-target releases above oversized/undersized ones at equal
   *  quality + custom-format score. */
  sizeDeviation: number | null;
  /** Video codec parsed from the release title. `null` when no
   *  recognised codec token appears. */
  videoCodec: 'AV1' | 'HEVC' | 'VP9' | 'x264' | null;
}

@Injectable()
export class EpisodeDownloadService {
  private readonly log = new Logger(EpisodeDownloadService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(DownloadHistory)
    private readonly historyRepo: Repository<DownloadHistory>,
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
    @InjectRepository(DownloadClient)
    private readonly clientRepo: Repository<DownloadClient>,
    private readonly torznab: TorznabService,
    private readonly qbittorrent: QbittorrentService,
    private readonly customFormats: CustomFormatsService,
    private readonly blocklist: BlocklistService,
    private readonly host: InProcessPluginHostClient,
    private readonly qualityDefs: QualityDefinitionsService,
    private readonly profiles: ProfilesService,
    private readonly events: EventsService,
  ) {}

  private allowedQualityIds(
    items: QualityProfileItem[] | undefined,
  ): Set<number> {
    return buildAllowedQualityIds(items);
  }

  private async getEpisodeWithContext(mediaId: number, episodeId: number) {
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['qualityProfile', 'languageProfile'],
    });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);
    if (media.type !== MediaType.SERIES) {
      throw new BadRequestException(
        'Episode grab is only available for series',
      );
    }

    const episode = await this.episodeRepo.findOne({
      where: { id: episodeId },
      relations: ['season', 'season.episodes'],
    });
    if (!episode)
      throw new NotFoundException(`Episode #${episodeId} not found`);
    if (episode.season.mediaId !== mediaId) {
      throw new BadRequestException('Episode does not belong to this media');
    }

    return { media, episode, season: episode.season };
  }

  async searchEpisodeReleases(
    mediaId: number,
    episodeId: number,
    customQuery?: string,
  ): Promise<EpisodeReleaseRow[]> {
    const { media, episode, season } = await this.getEpisodeWithContext(
      mediaId,
      episodeId,
    );

    const { allowed, allowedLangs } =
      this.profiles.resolveAllowedForMediaOrThrow(media, 'series');

    const indexers = await this.indexerRepo.find({
      where: { enabled: true },
      order: { priority: 'ASC', id: 'ASC' },
    });

    const sizeByQuality = await this.qualityDefs.getSizeLimitsMap();
    const indexerMinSeeders = buildIndexerMinSeeders(indexers);
    const indexerUnknownLang = new Map(
      indexers.map((ix) => [
        ix.id,
        ix.settings?.unknownLanguageIsoCode as string | undefined,
      ]),
    );

    const { searchTitle: queryTitle, expectedTitles: expectedTitle } =
      resolveSearchTitles(media, customQuery);
    const externalIds = { tvdbId: media.tvdbId, imdbId: media.imdbId };
    const ready = this.torznab.filterReadyIndexers(indexers);
    const label = `"${media.title}" S${String(season.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`;
    if (!ready.length) {
      this.log.warn(
        `[searchEpisodeReleases] ${label} — no indexer ready (${indexers.length} enabled)`,
      );
      return [];
    }
    this.log.log(
      `[searchEpisodeReleases] ${label} — query="${queryTitle}", indexers=[${ready.map((i) => i.name).join(', ')}]`,
    );
    const batches = await Promise.all(
      ready.map((ix) =>
        this.torznab.searchSeries(
          ix,
          queryTitle,
          season.seasonNumber,
          episode.episodeNumber,
          externalIds,
        ),
      ),
    );
    // Filter out releases that clearly belong to a different episode.
    // Some indexers (notably The Pirate Bay via Cardigann) ignore the
    // `season=` / `ep=` Torznab parameters and run a plain text search,
    // returning every episode of the show whose title matches. Keep
    // releases when:
    //   - the parser couldn't extract season/episode (could be a movie
    //     or oddly-named release — let scoring decide), OR
    //   - the season matches AND (episode matches OR it's a season pack
    //     that contains the target episode).
    const raw = batches.flat();
    const flat = raw.filter((r) => {
      const p = parseSeasonEpisode(r.title);
      if (p.season === null) return true;
      if (p.season !== season.seasonNumber) return false;
      if (p.isFullSeason) return true;
      if (p.episode === null) return true;
      return p.episode === episode.episodeNumber;
    });
    this.log.log(
      `[searchEpisodeReleases] ${label} — ${raw.length} raw result(s) across ${ready.length} indexer(s), ${flat.length} for this episode`,
    );

    // Season packs need their size scored against the WHOLE season's
    // runtime (sum of episode runtimes), not a single episode — else
    // a legit 25 GB 10-ep 2160p pack gets rejected as "oversize"
    // because the limit was computed for a 45-min slot.
    const defaultEpRuntime = media.runtime ?? 45;
    const episodeRuntime = episode.runtime ?? defaultEpRuntime;
    const seasonRuntime =
      (episode.season.episodes ?? []).reduce(
        (sum, ep) => sum + (ep.runtime ?? defaultEpRuntime),
        0,
      ) || episodeRuntime;

    const rowsWithKind = await Promise.all(
      flat.map(async (r) => {
        const isPack = parseSeasonEpisode(r.title).isFullSeason;
        const row = await this.buildReleaseRow(
          r,
          allowed,
          allowedLangs,
          sizeByQuality,
          indexerMinSeeders,
          isPack ? seasonRuntime : episodeRuntime,
          indexerUnknownLang,
          expectedTitle,
        );
        return { row, isPack };
      }),
    );

    // Drop releases that overshoot the profile — see equivalent
    // comment in MovieDownloadService.searchMovieReleases.
    const maxRank = maxAllowedRank(allowed);
    const withinProfile = rowsWithKind.filter((x) => x.row.rank <= maxRank);
    const accepted = withinProfile.filter(
      (x) => x.row.rejections.length === 0,
    ).length;
    this.log.log(
      `[searchEpisodeReleases] ${label} — ${withinProfile.length} within profile (rank ≤ ${maxRank}), ${accepted} accepted, ${withinProfile.length - accepted} rejected`,
    );

    // User is asking for ONE episode. Season packs still match, but
    // they download a whole season for a single episode — they should
    // rank below any equally-good single-episode release. Sort the two
    // groups independently then concatenate.
    const singles = sortReleasesByRelevance(
      withinProfile.filter((x) => !x.isPack).map((x) => x.row),
    );
    const packs = sortReleasesByRelevance(
      withinProfile.filter((x) => x.isPack).map((x) => x.row),
    );
    // Singles-before-packs holds only among live releases: a dead single
    // can't import, so a well-seeded pack covering the episode outranks it.
    const alive = (r: { seeders: number }) => r.seeders > 0;
    return [
      ...singles.filter(alive),
      ...packs.filter(alive),
      ...singles.filter((r) => !alive(r)),
      ...packs.filter((r) => !alive(r)),
    ];
  }

  async grabEpisode(
    mediaId: number,
    episodeId: number,
    dto?: GrabMovieDto,
  ): Promise<DownloadHistory> {
    const { media, episode, season } = await this.getEpisodeWithContext(
      mediaId,
      episodeId,
    );
    if (!media.libraryId) {
      throw new BadRequestException(
        'Assign a library to this series before downloading',
      );
    }

    const { allowed } = this.profiles.resolveAllowedForMediaOrThrow(
      media,
      'series',
    );

    let downloadUrl = dto?.downloadUrl?.trim();
    let sourceTitle = dto?.sourceTitle?.trim();
    let indexerId = dto?.indexerId;
    const grabSource: 'auto' | 'manual' = downloadUrl ? 'manual' : 'auto';

    const epLabel = `S${String(season.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`;
    this.log.log(
      `grabEpisode #${mediaId} "${media.title}" ${epLabel} — manual URL: ${downloadUrl || '(auto)'}`,
    );

    if (!downloadUrl) {
      const rows = await this.searchEpisodeReleases(mediaId, episodeId);
      const pick =
        rows.find(
          (r) => r.allowed && !r.blocklisted && r.rejections.length === 0,
        ) ?? rows.find((r) => r.allowed && !r.blocklisted);
      if (!pick) {
        throw new BadRequestException(
          'No release matches the quality and language profiles. Add indexers or widen the profiles.',
        );
      }
      downloadUrl = pick.downloadUrl;
      sourceTitle = pick.title;
      indexerId = pick.indexerId;
      this.log.log(`Auto-picked: "${sourceTitle}" — ${downloadUrl}`);
    } else {
      if (!sourceTitle) sourceTitle = downloadUrl.slice(0, 240);
      if (await this.blocklist.isBlocked(sourceTitle)) {
        throw new BadRequestException(
          `"${sourceTitle}" is in the blocklist and cannot be downloaded.`,
        );
      }
    }

    const parsed = parseReleaseQuality(sourceTitle);
    if (!allowed.has(parsed.quality.id)) {
      throw new BadRequestException(
        `This release (${parsed.quality.name}) is not allowed by the series quality profile`,
      );
    }

    const clients = await this.clientRepo.find({
      order: { priority: 'ASC', id: 'ASC' },
    });
    const qbit = clients.find((c) => this.qbittorrent.supports(c));
    if (!qbit) {
      throw new BadRequestException(
        'No enabled qBittorrent download client configured',
      );
    }

    this.log.log(`Sending to qBittorrent: "${sourceTitle}" — ${downloadUrl}`);
    const torrentHash = await this.qbittorrent.addTorrentUrl(
      qbit,
      downloadUrl,
      'series',
    );
    this.log.log(`Grab successful for "${sourceTitle}" (hash=${torrentHash})`);

    const saved = await this.historyRepo.save(
      this.historyRepo.create(
        buildGrabHistoryRow({
          media,
          downloadClient: qbit,
          sourceTitle,
          torrentHash,
          quality: parsed.quality.name,
          grabSource,
          indexerId,
          episodeId: episode.id,
          seasonId: season.id,
        }),
      ),
    );

    void this.host['notifications.dispatch']({
      event: 'grab.started',
      payload: {
        title: `${media.title} ${epLabel}`,
        quality: parsed.quality.name,
        sourceTitle,
      },
    });

    this.events.emitDomain({
      type: 'acquisition.grabbed',
      mediaId,
      seasonNumber: season.seasonNumber,
    });

    return saved;
  }

  // ---------------------------------------------------------------------------
  // Season grab
  // ---------------------------------------------------------------------------

  private async buildReleaseRow(
    r: ReleaseCandidate,
    allowed: Set<number>,
    allowedLangs: Set<number>,
    sizeByQuality: Map<number, SizeLimits>,
    indexerMinSeeders: Map<number, number>,
    runtimeMinutes: number,
    indexerUnknownLang: Map<number, string | undefined>,
    expectedTitle?: string | string[],
  ): Promise<EpisodeReleaseRow> {
    const parsed = parseReleaseQuality(r.title);
    const lang = resolveUnknownLanguage(
      parseReleaseLanguage(r.title),
      indexerUnknownLang.get(r.indexerId),
    );
    const [cfScore, isBlocklisted] = await Promise.all([
      this.customFormats.scoreRelease(r.title, {
        freeleech: r.freeleech,
        downloadVolumeFactor: r.downloadVolumeFactor,
      }),
      this.blocklist.isBlocked(r.title),
    ]);
    const rejections = computeRejections({
      qualityId: parsed.quality.id,
      allowed,
      languageId: lang.id,
      allowedLangs,
      isBlocklisted,
      sizeBytes: r.size,
      runtimeMinutes,
      sizeByQuality,
      seeders: r.seeders,
      indexerId: r.indexerId,
      indexerMinSeeders,
      releaseTitle: r.title,
      expectedTitle,
    });
    const isFullSeason = parseSeasonEpisode(r.title).isFullSeason;
    const sizeDeviation = computeSizeDeviation(
      r.title,
      r.size,
      runtimeMinutes,
      sizeByQuality.get(parsed.quality.id),
    );
    return {
      title: r.title,
      downloadUrl: r.downloadUrl,
      qualityId: parsed.quality.id,
      qualityName: parsed.quality.name,
      rank: parsed.quality.rank,
      allowed: allowed.has(parsed.quality.id),
      customFormatScore: cfScore,
      blocklisted: isBlocklisted,
      indexerId: r.indexerId,
      indexerName: r.indexerName,
      languageId: lang.id,
      languageName: lang.name,
      languageAllowed: allowedLangs.size === 0 || allowedLangs.has(lang.id),
      size: r.size,
      seeders: r.seeders,
      leechers: r.leechers,
      rejections,
      freeleech: r.freeleech,
      downloadVolumeFactor: r.downloadVolumeFactor,
      isFullSeason,
      sizeDeviation,
      videoCodec: detectVideoCodec(r.title),
    };
  }

  async searchSeasonReleases(
    mediaId: number,
    seasonId: number,
    customQuery?: string,
  ): Promise<EpisodeReleaseRow[]> {
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['qualityProfile', 'languageProfile'],
    });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);
    if (media.type !== MediaType.SERIES) {
      throw new BadRequestException(
        'Season search is only available for series',
      );
    }

    const season = await this.seasonRepo.findOne({
      where: { id: seasonId },
      relations: ['episodes'],
    });
    if (!season || season.mediaId !== mediaId) {
      throw new NotFoundException(
        `Season #${seasonId} not found on this media`,
      );
    }

    const { allowed, allowedLangs } =
      this.profiles.resolveAllowedForMediaOrThrow(media, 'series');

    const indexers = await this.indexerRepo.find({
      where: { enabled: true },
      order: { priority: 'ASC', id: 'ASC' },
    });

    const sizeByQuality = await this.qualityDefs.getSizeLimitsMap();
    const indexerMinSeeders = buildIndexerMinSeeders(indexers);
    const indexerUnknownLang = new Map(
      indexers.map((ix) => [
        ix.id,
        ix.settings?.unknownLanguageIsoCode as string | undefined,
      ]),
    );
    const defaultEpRuntime = media.runtime ?? 45;
    const seasonRuntime =
      (season.episodes ?? []).reduce(
        (sum, ep) => sum + (ep.runtime ?? defaultEpRuntime),
        0,
      ) || defaultEpRuntime;

    const { searchTitle, expectedTitles: expectedTitle } =
      resolveSearchTitles(media, customQuery);
    const externalIds = { tvdbId: media.tvdbId, imdbId: media.imdbId };
    const ready = this.torznab.filterReadyIndexers(indexers);
    const label = `"${media.title}" S${String(season.seasonNumber).padStart(2, '0')}`;
    if (!ready.length) {
      this.log.warn(
        `[searchSeasonReleases] ${label} — no indexer ready (${indexers.length} enabled)`,
      );
      return [];
    }
    this.log.log(
      `[searchSeasonReleases] ${label} — query="${searchTitle}", indexers=[${ready.map((i) => i.name).join(', ')}]`,
    );
    const batches = await Promise.all(
      ready.map((ix) =>
        this.torznab.searchSeasonPack(
          ix,
          searchTitle,
          season.seasonNumber,
          externalIds,
        ),
      ),
    );

    // Same fan-out drift as the per-episode path: some indexers
    // ignore `season=` and return any release whose title contains
    // the show name. Keep only releases that parse to the requested
    // season (single episodes or full packs alike).
    const raw = batches.flat();
    const flat = raw.filter((r) => {
      const p = parseSeasonEpisode(r.title);
      if (p.season === null) return true;
      return p.season === season.seasonNumber;
    });
    this.log.log(
      `[searchSeasonReleases] ${label} — ${raw.length} raw result(s) across ${ready.length} indexer(s), ${flat.length} for this season`,
    );

    const defaultEpisodeRuntime = media.runtime ?? 45;
    const rowsWithKind = await Promise.all(
      flat.map(async (r) => {
        const isPack = parseSeasonEpisode(r.title).isFullSeason;
        const row = await this.buildReleaseRow(
          r,
          allowed,
          allowedLangs,
          sizeByQuality,
          indexerMinSeeders,
          isPack ? seasonRuntime : defaultEpisodeRuntime,
          indexerUnknownLang,
          expectedTitle,
        );
        return { row, isPack };
      }),
    );

    // Drop releases that overshoot the profile, and drop single
    // episodes — the user asked for a season pack, releases that
    // happen to match the show but aren't packs aren't relevant
    // here. The auto-grab path still falls back to per-episode
    // search if no pack works.
    const maxRank = maxAllowedRank(allowed);
    const packs = rowsWithKind
      .filter((x) => x.isPack && x.row.rank <= maxRank)
      .map((x) => x.row);
    const accepted = packs.filter((r) => r.rejections.length === 0).length;
    this.log.log(
      `[searchSeasonReleases] ${label} — ${packs.length} pack(s) within profile (rank ≤ ${maxRank}), ${accepted} accepted, ${packs.length - accepted} rejected`,
    );
    return sortReleasesByRelevance(packs);
  }

  async grabSeason(
    mediaId: number,
    seasonId: number,
    dto?: GrabMovieDto,
  ): Promise<{ grabbed: number; errors: string[] }> {
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['qualityProfile', 'languageProfile'],
    });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);
    if (media.type !== MediaType.SERIES) {
      throw new BadRequestException('Season grab is only available for series');
    }
    if (!media.libraryId) {
      throw new BadRequestException(
        'Assign a library to this series before downloading',
      );
    }

    const season = await this.seasonRepo.findOne({
      where: { id: seasonId },
      relations: ['episodes'],
    });
    if (!season || season.mediaId !== mediaId) {
      throw new NotFoundException(
        `Season #${seasonId} not found on this media`,
      );
    }

    const { allowed, allowedLangs } =
      this.profiles.resolveAllowedForMediaOrThrow(media, 'series');

    const clients = await this.clientRepo.find({
      order: { priority: 'ASC', id: 'ASC' },
    });
    const qbit = clients.find((c) => this.qbittorrent.supports(c));
    if (!qbit) {
      throw new BadRequestException(
        'No enabled qBittorrent download client configured',
      );
    }

    this.log.log(
      `grabSeason #${mediaId} S${String(season.seasonNumber).padStart(2, '0')} — manual URL: ${dto?.downloadUrl?.trim() || '(auto)'}`,
    );

    // --- Manual URL: just add it directly ---
    if (dto?.downloadUrl?.trim()) {
      const downloadUrl = dto.downloadUrl.trim();
      const sourceTitle = dto.sourceTitle?.trim() || downloadUrl.slice(0, 240);
      if (await this.blocklist.isBlocked(sourceTitle)) {
        throw new BadRequestException(`"${sourceTitle}" is in the blocklist`);
      }
      const parsed = parseReleaseQuality(sourceTitle);
      this.log.log(`Sending to qBittorrent: "${sourceTitle}" — ${downloadUrl}`);
      const torrentHash = await this.qbittorrent.addTorrentUrl(
        qbit,
        downloadUrl,
        'series',
      );
      this.log.log(
        `Grab successful for "${sourceTitle}" (hash=${torrentHash})`,
      );
      await this.historyRepo.save(
        this.historyRepo.create(
          buildGrabHistoryRow({
            media: { id: mediaId },
            downloadClient: qbit,
            sourceTitle,
            torrentHash,
            quality: parsed.quality.name,
            grabSource: 'manual',
            indexerId: dto?.indexerId,
            seasonId: season.id,
          }),
        ),
      );
      void this.host['notifications.dispatch']({
        event: 'grab.started',
        payload: {
          title: `${media.title} S${String(season.seasonNumber).padStart(2, '0')}`,
          quality: parsed.quality.name,
          sourceTitle,
        },
      });
      this.events.emitDomain({
        type: 'acquisition.grabbed',
        mediaId,
        seasonNumber: season.seasonNumber,
      });
      return { grabbed: 1, errors: [] };
    }

    // --- Auto: try season pack first ---
    const indexers = await this.indexerRepo.find({
      where: { enabled: true },
      order: { priority: 'ASC', id: 'ASC' },
    });

    const sizeByQuality = await this.qualityDefs.getSizeLimitsMap();
    const indexerMinSeeders = buildIndexerMinSeeders(indexers);
    const indexerUnknownLang = new Map(
      indexers.map((ix) => [
        ix.id,
        ix.settings?.unknownLanguageIsoCode as string | undefined,
      ]),
    );

    const externalIds = { tvdbId: media.tvdbId, imdbId: media.imdbId };
    const { searchTitle, expectedTitles } = resolveSearchTitles(media);
    const ready = this.torznab.filterReadyIndexers(indexers);
    const packBatches = await Promise.all(
      ready.map((ix) =>
        this.torznab.searchSeasonPack(
          ix,
          searchTitle,
          season.seasonNumber,
          externalIds,
        ),
      ),
    );
    // Season pack runtime = episode runtime × number of episodes
    const defaultEpRuntime = media.runtime ?? 45;
    const seasonRuntime =
      (season.episodes ?? []).reduce(
        (sum, ep) => sum + (ep.runtime ?? defaultEpRuntime),
        0,
      ) || defaultEpRuntime;

    // Indexer-side `season=` filtering isn't honoured by every backend
    // (notably TPB via Cardigann), so the result set can contain single
    // episodes of the same show. We only treat actual full-season
    // packs as candidates — otherwise the auto-grab would download a
    // random S01EXX and call it a "season grab".
    const packRows = await Promise.all(
      packBatches
        .flat()
        .filter((r) => matchesSeasonPack(r.title, season.seasonNumber))
        .map((r) =>
          this.buildReleaseRow(
            r,
            allowed,
            allowedLangs,
            sizeByQuality,
            indexerMinSeeders,
            seasonRuntime,
            indexerUnknownLang,
            expectedTitles,
          ),
        ),
    );
    sortReleasesByRelevance(packRows);

    const bestPack = packRows.find(
      (r) => r.allowed && !r.blocklisted && r.rejections.length === 0,
    );
    if (bestPack) {
      this.log.log(
        `Season pack found: "${bestPack.title}" — sending to qBittorrent: ${bestPack.downloadUrl}`,
      );
      const packHash = await this.qbittorrent.addTorrentUrl(
        qbit,
        bestPack.downloadUrl,
        'series',
      );
      this.log.log(
        `Season pack grab successful for "${bestPack.title}" (hash=${packHash})`,
      );
      await this.historyRepo.save(
        this.historyRepo.create(
          buildGrabHistoryRow({
            media: { id: mediaId },
            downloadClient: qbit,
            sourceTitle: bestPack.title,
            torrentHash: packHash,
            quality: bestPack.qualityName,
            grabSource: 'auto',
            indexerId: bestPack.indexerId,
            seasonId: season.id,
          }),
        ),
      );
      void this.host['notifications.dispatch']({
        event: 'grab.started',
        payload: {
          title: `${media.title} S${String(season.seasonNumber).padStart(2, '0')}`,
          quality: bestPack.qualityName,
          sourceTitle: bestPack.title,
        },
      });
      this.events.emitDomain({
        type: 'acquisition.grabbed',
        mediaId,
        seasonNumber: season.seasonNumber,
      });
      return { grabbed: 1, errors: [] };
    }

    // --- Fallback: grab each missing episode individually ---
    this.log.log(`No season pack found, falling back to per-episode grab`);
    const today = new Date().toISOString().slice(0, 10);
    const allEpisodes = season.episodes ?? [];
    const onDiskNums = onDiskEpisodeNumbers(allEpisodes);
    const missingEpisodes = allEpisodes.filter(
      (ep) =>
        ep.monitored &&
        !onDiskNums.has(ep.episodeNumber) &&
        ep.airDate &&
        ep.airDate <= today,
    );
    const skippedCount = allEpisodes.length - missingEpisodes.length;
    this.log.log(
      `Per-episode grab: ${missingEpisodes.length}/${allEpisodes.length} episode(s) eligible (${skippedCount} skipped — not monitored, already on disk, or not yet aired)`,
    );
    if (missingEpisodes.length === 0) {
      return {
        grabbed: 0,
        errors: ['No monitored, missing, and aired episodes to grab'],
      };
    }

    let grabbed = 0;
    const errors: string[] = [];

    for (const ep of missingEpisodes) {
      const epLabel = `S${String(season.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`;
      try {
        const epBatches = await Promise.all(
          ready.map((ix) =>
            this.torznab.searchSeries(
              ix,
              searchTitle,
              season.seasonNumber,
              ep.episodeNumber,
              externalIds,
            ),
          ),
        );
        const rawCount = epBatches.flat().length;
        const epFlat = epBatches.flat().filter((r) => {
          const p = parseSeasonEpisode(r.title);
          if (p.season === null) return true;
          if (p.season !== season.seasonNumber) return false;
          if (p.isFullSeason) return true;
          if (p.episode === null) return true;
          return p.episode === ep.episodeNumber;
        });
        const epRuntime = ep.runtime ?? media.runtime ?? 45;
        const epRows = await Promise.all(
          epFlat.map((r) => {
            const isPack = parseSeasonEpisode(r.title).isFullSeason;
            return this.buildReleaseRow(
              r,
              allowed,
              allowedLangs,
              sizeByQuality,
              indexerMinSeeders,
              isPack ? seasonRuntime : epRuntime,
              indexerUnknownLang,
              expectedTitles,
            );
          }),
        );
        sortReleasesByRelevance(epRows);

        const pick = epRows.find(
          (r) => r.allowed && !r.blocklisted && r.rejections.length === 0,
        );
        if (!pick) {
          this.log.warn(
            `[${epLabel}] no matching release (${rawCount} raw, ${epFlat.length} after ep filter, ${epRows.length} scored)`,
          );
          continue;
        }

        this.log.log(
          `[${epLabel}] sending to qBittorrent: "${pick.title}" — ${pick.downloadUrl}`,
        );
        const epHash = await this.qbittorrent.addTorrentUrl(
          qbit,
          pick.downloadUrl,
          'series',
        );
        this.log.log(
          `[${epLabel}] grab successful for "${pick.title}" (hash=${epHash})`,
        );
        await this.historyRepo.save(
          this.historyRepo.create(
            buildGrabHistoryRow({
              media: { id: mediaId },
              downloadClient: qbit,
              sourceTitle: pick.title,
              torrentHash: epHash,
              quality: pick.qualityName,
              grabSource: 'auto',
              indexerId: pick.indexerId,
              episodeId: ep.id,
              seasonId: season.id,
            }),
          ),
        );
        grabbed++;
      } catch (e) {
        this.log.error(`[${epLabel}] grab failed: ${(e as Error).message}`);
        errors.push(`${epLabel}: ${(e as Error).message}`);
      }
    }

    this.log.log(
      `Per-episode grab complete: ${grabbed} grabbed, ${missingEpisodes.length - grabbed - errors.length} skipped (no release), ${errors.length} errored`,
    );
    if (grabbed === 0 && errors.length === 0) {
      errors.push('No matching release found for any episode in this season');
    }

    if (grabbed > 0) {
      this.events.emitDomain({
        type: 'acquisition.grabbed',
        mediaId,
        seasonNumber: season.seasonNumber,
      });
    }

    return { grabbed, errors };
  }
}
