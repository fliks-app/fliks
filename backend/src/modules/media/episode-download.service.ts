import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Media } from './entities/media.entity';
import { Season } from './entities/season.entity';
import { Episode } from './entities/episode.entity';
import { DownloadHistory } from './entities/download-history.entity';
import { Indexer } from '../indexers/entities/indexer.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { TorznabService } from '../indexers/torznab.service';
import { QbittorrentService } from '../download-clients/qbittorrent.service';
import { parseReleaseQuality } from './release-quality.parser';
import { parseReleaseLanguage } from './release-language.parser';
import { CustomFormatsService } from '../profiles/custom-formats.service';
import { QualityDefinitionsService } from '../profiles/quality-definitions.service';
import { BlocklistService } from '../blocklist/blocklist.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MediaType } from '../../common/enums';
import { QualityProfileItem } from '../profiles/entities/quality-profile.entity';
import { LanguageProfileItem } from '../profiles/entities/language-profile.entity';

function allowedLanguageIds(items: LanguageProfileItem[] | undefined): Set<number> {
  const set = new Set<number>();
  if (!items?.length) return set;
  for (const row of items) {
    if (row.allowed) set.add(row.language.id);
  }
  return set;
}
import { GrabMovieDto } from './dto/grab-movie.dto';
import {
  ReleaseRejection,
  buildIndexerMinSeeders,
  buildAllowedQualityIds,
  computeRejections,
  SizeLimits,
} from './release-rejection.helper';


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
    private readonly notifications: NotificationsService,
    private readonly qualityDefs: QualityDefinitionsService,
  ) {}

  private allowedQualityIds(items: QualityProfileItem[] | undefined): Set<number> {
    return buildAllowedQualityIds(items);
  }

  private async getEpisodeWithContext(mediaId: number, episodeId: number) {
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['qualityProfile', 'languageProfile'],
    });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);
    if (media.type !== MediaType.SERIES) {
      throw new BadRequestException('Episode grab is only available for series');
    }

    const episode = await this.episodeRepo.findOne({
      where: { id: episodeId },
      relations: ['season'],
    });
    if (!episode) throw new NotFoundException(`Episode #${episodeId} not found`);
    if (episode.season.mediaId !== mediaId) {
      throw new BadRequestException('Episode does not belong to this media');
    }

    return { media, episode, season: episode.season };
  }

  async searchEpisodeReleases(mediaId: number, episodeId: number, customQuery?: string): Promise<EpisodeReleaseRow[]> {
    const { media, episode, season } = await this.getEpisodeWithContext(mediaId, episodeId);

    const allowed = this.allowedQualityIds(media.qualityProfile?.items);
    if (!allowed.size) {
      throw new BadRequestException(
        'Assign a quality profile with at least one allowed quality to this series',
      );
    }



    const indexers = await this.indexerRepo.find({
      where: { enabled: true },
      order: { priority: 'ASC', id: 'ASC' },
    });

    const allowedLangs = allowedLanguageIds(media.languageProfile?.languages);
    const sizeByQuality = await this.qualityDefs.getSizeLimitsMap();
    const indexerMinSeeders = buildIndexerMinSeeders(indexers);

    const searchQuery = customQuery?.trim();
    const batches = await Promise.all(
      searchQuery
        ? indexers.map((ix) => this.torznab.searchSeries(ix, searchQuery, season.seasonNumber, episode.episodeNumber))
        : indexers.map((ix) => this.torznab.searchSeries(ix, media.title, season.seasonNumber, episode.episodeNumber)),
    );
    const flat = batches.flat();

    const rows = await Promise.all(
      flat.map((r) => this.buildReleaseRow(r, allowed, allowedLangs, sizeByQuality, indexerMinSeeders)),
    );

    rows.sort((a, b) =>
      b.rank !== a.rank ? b.rank - a.rank : b.customFormatScore - a.customFormatScore,
    );
    return rows;
  }

  async grabEpisode(
    mediaId: number,
    episodeId: number,
    dto?: GrabMovieDto,
  ): Promise<DownloadHistory> {
    const { media, episode, season } = await this.getEpisodeWithContext(mediaId, episodeId);

    const allowed = this.allowedQualityIds(media.qualityProfile?.items);
    if (!allowed.size) {
      throw new BadRequestException(
        'Assign a quality profile with at least one allowed quality to this series',
      );
    }



    let downloadUrl = dto?.downloadUrl?.trim();
    let sourceTitle = dto?.sourceTitle?.trim();

    const epLabel = `S${String(season.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`;
    this.log.log(`grabEpisode #${mediaId} "${media.title}" ${epLabel} — manual URL: ${downloadUrl || '(auto)'}`);

    if (!downloadUrl) {
      const rows = await this.searchEpisodeReleases(mediaId, episodeId);
      const pick = rows.find((r) => r.allowed && !r.blocklisted && r.rejections.length === 0)
        ?? rows.find((r) => r.allowed && !r.blocklisted);
      if (!pick) {
        throw new BadRequestException(
          'No release matches the quality and language profiles. Add indexers or widen the profiles.',
        );
      }
      downloadUrl = pick.downloadUrl;
      sourceTitle = pick.title;
      this.log.log(`Auto-picked: "${sourceTitle}" — ${downloadUrl}`);
    } else {
      if (!sourceTitle) sourceTitle = downloadUrl.slice(0, 240);
      if (await this.blocklist.isBlocked(sourceTitle)) {
        throw new BadRequestException(
          `"${sourceTitle}" is in the blocklist and cannot be downloaded.`,
        );
      }
    }

    const parsed = parseReleaseQuality(sourceTitle!);
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
      throw new BadRequestException('No enabled qBittorrent download client configured');
    }

    this.log.log(`Sending to qBittorrent: "${sourceTitle}" — ${downloadUrl}`);
    await this.qbittorrent.addTorrentUrl(qbit, downloadUrl!, 'series');
    this.log.log(`Grab successful for "${sourceTitle}"`);

    const row = this.historyRepo.create({
      mediaId: media.id,
      downloadClientId: qbit.id,
      sourceTitle: sourceTitle!,
      quality: parsed.quality.name,
      status: 'grabbed',
    });
    const saved = await this.historyRepo.save(row);

    void this.notifications.dispatch('grab.started', {
      title: `${media.title} ${epLabel}`,
      quality: parsed.quality.name,
      sourceTitle,
    });

    return saved;
  }

  // ---------------------------------------------------------------------------
  // Season grab
  // ---------------------------------------------------------------------------

  private async buildReleaseRow(
    r: import('../indexers/torznab.service').TorznabRelease,
    allowed: Set<number>,
    allowedLangs: Set<number>,
    sizeByQuality: Map<number, SizeLimits>,
    indexerMinSeeders: Map<number, number>,
  ): Promise<EpisodeReleaseRow> {
    const parsed = parseReleaseQuality(r.title);
    const lang = parseReleaseLanguage(r.title);
    const [cfScore, isBlocklisted] = await Promise.all([
      this.customFormats.scoreRelease(r.title, { freeleech: r.freeleech, downloadVolumeFactor: r.downloadVolumeFactor }),
      this.blocklist.isBlocked(r.title),
    ]);
    const rejections = computeRejections({
      qualityId: parsed.quality.id,
      allowed,
      languageId: lang.id,
      allowedLangs,
      isBlocklisted,
      sizeBytes: r.size,
      sizeByQuality,
      seeders: r.seeders,
      indexerId: r.indexerId,
      indexerMinSeeders,
    });
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
    };
  }

  async searchSeasonReleases(mediaId: number, seasonId: number, customQuery?: string): Promise<EpisodeReleaseRow[]> {
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['qualityProfile', 'languageProfile'],
    });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);
    if (media.type !== MediaType.SERIES) {
      throw new BadRequestException('Season search is only available for series');
    }

    const season = await this.seasonRepo.findOne({ where: { id: seasonId } });
    if (!season || season.mediaId !== mediaId) {
      throw new NotFoundException(`Season #${seasonId} not found on this media`);
    }

    const allowed = this.allowedQualityIds(media.qualityProfile?.items);
    if (!allowed.size) {
      throw new BadRequestException(
        'Assign a quality profile with at least one allowed quality to this series',
      );
    }


    const indexers = await this.indexerRepo.find({
      where: { enabled: true },
      order: { priority: 'ASC', id: 'ASC' },
    });

    const allowedLangs = allowedLanguageIds(media.languageProfile?.languages);
    const sizeByQuality = await this.qualityDefs.getSizeLimitsMap();
    const indexerMinSeeders = buildIndexerMinSeeders(indexers);

    const searchTitle = customQuery?.trim() || media.title;
    const batches = await Promise.all(
      indexers.map((ix) =>
        this.torznab.searchSeasonPack(ix, searchTitle, season.seasonNumber),
      ),
    );

    const rows = await Promise.all(
      batches.flat().map((r) => this.buildReleaseRow(r, allowed, allowedLangs, sizeByQuality, indexerMinSeeders)),
    );

    rows.sort((a, b) =>
      b.rank !== a.rank ? b.rank - a.rank : b.customFormatScore - a.customFormatScore,
    );
    return rows;
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

    const season = await this.seasonRepo.findOne({
      where: { id: seasonId },
      relations: ['episodes'],
    });
    if (!season || season.mediaId !== mediaId) {
      throw new NotFoundException(`Season #${seasonId} not found on this media`);
    }

    const allowed = this.allowedQualityIds(media.qualityProfile?.items);
    if (!allowed.size) {
      throw new BadRequestException(
        'Assign a quality profile with at least one allowed quality to this series',
      );
    }


    const clients = await this.clientRepo.find({ order: { priority: 'ASC', id: 'ASC' } });
    const qbit = clients.find((c) => this.qbittorrent.supports(c));
    if (!qbit) {
      throw new BadRequestException('No enabled qBittorrent download client configured');
    }

    this.log.log(`grabSeason #${mediaId} S${String(season.seasonNumber).padStart(2, '0')} — manual URL: ${dto?.downloadUrl?.trim() || '(auto)'}`);

    // --- Manual URL: just add it directly ---
    if (dto?.downloadUrl?.trim()) {
      const downloadUrl = dto.downloadUrl.trim();
      const sourceTitle = dto.sourceTitle?.trim() || downloadUrl.slice(0, 240);
      if (await this.blocklist.isBlocked(sourceTitle)) {
        throw new BadRequestException(`"${sourceTitle}" is in the blocklist`);
      }
      const parsed = parseReleaseQuality(sourceTitle);
      await this.qbittorrent.addTorrentUrl(qbit, downloadUrl, 'series');
      await this.historyRepo.save(
        this.historyRepo.create({
          mediaId,
          downloadClientId: qbit.id,
          sourceTitle,
          quality: parsed.quality.name,
          status: 'grabbed',
        }),
      );
      void this.notifications.dispatch('grab.started', {
        title: `${media.title} S${String(season.seasonNumber).padStart(2, '0')}`,
        quality: parsed.quality.name,
        sourceTitle,
      });
      return { grabbed: 1, errors: [] };
    }

    // --- Auto: try season pack first ---
    const indexers = await this.indexerRepo.find({
      where: { enabled: true },
      order: { priority: 'ASC', id: 'ASC' },
    });

    const allowedLangs = allowedLanguageIds(media.languageProfile?.languages);
    const sizeByQuality = await this.qualityDefs.getSizeLimitsMap();
    const indexerMinSeeders = buildIndexerMinSeeders(indexers);

    const packBatches = await Promise.all(
      indexers.map((ix) =>
        this.torznab.searchSeasonPack(ix, media.title, season.seasonNumber),
      ),
    );
    const packRows = await Promise.all(
      packBatches.flat().map((r) => this.buildReleaseRow(r, allowed, allowedLangs, sizeByQuality, indexerMinSeeders)),
    );
    packRows.sort((a, b) =>
      b.rank !== a.rank ? b.rank - a.rank : b.customFormatScore - a.customFormatScore,
    );

    const bestPack = packRows.find((r) => r.allowed && !r.blocklisted && r.rejections.length === 0);
    if (bestPack) {
      this.log.log(`Season pack found: "${bestPack.title}" — ${bestPack.downloadUrl}`);
      await this.qbittorrent.addTorrentUrl(qbit, bestPack.downloadUrl, 'series');
      await this.historyRepo.save(
        this.historyRepo.create({
          mediaId,
          downloadClientId: qbit.id,
          sourceTitle: bestPack.title,
          quality: bestPack.qualityName,
          status: 'grabbed',
        }),
      );
      void this.notifications.dispatch('grab.started', {
        title: `${media.title} S${String(season.seasonNumber).padStart(2, '0')}`,
        quality: bestPack.qualityName,
        sourceTitle: bestPack.title,
      });
      return { grabbed: 1, errors: [] };
    }

    // --- Fallback: grab each missing episode individually ---
    this.log.log(`No season pack found, falling back to per-episode grab`);
    const today = new Date().toISOString().slice(0, 10);
    const missingEpisodes = (season.episodes ?? []).filter(
      (ep) => ep.monitored && !ep.hasFile && ep.airDate && ep.airDate <= today,
    );

    let grabbed = 0;
    const errors: string[] = [];

    for (const ep of missingEpisodes) {
      try {
        const epBatches = await Promise.all(
          indexers.map((ix) =>
            this.torznab.searchSeries(ix, media.title, season.seasonNumber, ep.episodeNumber),
          ),
        );
        const epRows = await Promise.all(
          epBatches.flat().map((r) => this.buildReleaseRow(r, allowed, allowedLangs, sizeByQuality, indexerMinSeeders)),
        );
        epRows.sort((a, b) =>
          b.rank !== a.rank ? b.rank - a.rank : b.customFormatScore - a.customFormatScore,
        );

        const pick = epRows.find((r) => r.allowed && !r.blocklisted && r.rejections.length === 0);
        if (!pick) continue;

        await this.qbittorrent.addTorrentUrl(qbit, pick.downloadUrl, 'series');
        await this.historyRepo.save(
          this.historyRepo.create({
            mediaId,
            downloadClientId: qbit.id,
            sourceTitle: pick.title,
            quality: pick.qualityName,
            status: 'grabbed',
          }),
        );
        grabbed++;
      } catch (e) {
        const epLabel = `S${String(season.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`;
        errors.push(`${epLabel}: ${(e as Error).message}`);
      }
    }

    if (grabbed === 0 && errors.length === 0) {
      errors.push('No matching release found for any episode in this season');
    }

    return { grabbed, errors };
  }
}
