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
import { DownloadHistory } from './entities/download-history.entity';
import { buildGrabHistoryRow } from './grab-history.util';
import { Indexer } from './indexers/entities/indexer.entity';
import { DownloadClient } from './download-clients/entities/download-client.entity';
import { TorznabService } from './indexers/torznab.service';
import { QbittorrentService } from './download-clients/qbittorrent.service';
import { CustomFormatsService } from '../../modules/profiles/custom-formats.service';
import { ProfilesService } from '../../modules/profiles/profiles.service';
import { QualityDefinitionsService } from '../../modules/profiles/quality-definitions.service';
import { BlocklistService } from './blocklist/blocklist.service';
import { InProcessPluginHostClient } from '../../modules/plugins/host/in-process-plugin-host-client';
import { MediaType } from '../../common/enums';
import { GrabMovieDto } from './dto/grab-movie.dto';
import { QualityProfileItem } from '../../modules/profiles/entities/quality-profile.entity';
import {
  getAppQualityById,
  maxAllowedRank,
} from '../../common/constants/app-qualities';
import { parseReleaseQuality } from '../../common/release-parsing';
import {
  ReleaseCandidate,
  ReleaseRejection,
  buildIndexerMinSeeders,
  buildAllowedQualityIds,
  allowedAudioLanguageIds,
  maxResolutionFromQualityStrings,
  resolveSearchTitles,
  scoreAndSortReleases,
  sortReleasesByRelevance,
  formatRejectionForLog,
} from '../../common/release-scoring';

function inferTitleFromTorrentUrl(url: string): string {
  if (url.startsWith('magnet:')) {
    const m = url.match(/[?&]dn=([^&]+)/i);
    if (m) {
      try {
        return decodeURIComponent(m[1].replace(/\+/g, ' '));
      } catch {
        return m[1];
      }
    }
  }
  return url.slice(0, 240);
}

export interface MovieReleaseRow {
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
  isFullSeason: boolean;
  sizeDeviation: number | null;
  videoCodec: 'AV1' | 'HEVC' | 'VP9' | 'x264' | null;
}

@Injectable()
export class MovieDownloadService {
  private readonly log = new Logger(MovieDownloadService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
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

  private async buildMovieReleaseRows(
    releases: ReleaseCandidate[],
    media: Media,
    indexers: Indexer[],
    allowed: Set<number>,
    allowedLangs: Set<number>,
    expectedTitle?: string | string[],
  ): Promise<MovieReleaseRow[]> {
    const scored = await scoreAndSortReleases(
      releases,
      {
        allowed,
        allowedLangs,
        sizeByQuality: await this.qualityDefs.getSizeLimitsMap(),
        indexerMinSeeders: buildIndexerMinSeeders(indexers),
        indexerUnknownLang: new Map(
          indexers.map((ix) => [
            ix.id,
            ix.settings?.unknownLanguageIsoCode as string | undefined,
          ]),
        ),
        runtimeMinutes: media.runtime ?? 0,
        expectedTitle,
      },
      {
        scoreCustomFormats: (title, meta) =>
          this.customFormats.scoreRelease(title, meta),
        isBlocked: (title) => this.blocklist.isBlocked(title),
      },
    );
    // scoreAndSortReleases returns ScoredRelease; MovieReleaseRow is a
    // superset with leechers + downloadVolumeFactor which are already on
    // the spread ReleaseCandidate fields.
    return scored as MovieReleaseRow[];
  }

  private searchIndexer(
    indexer: Indexer,
    query: string,
    media?: Media,
  ): Promise<ReleaseCandidate[]> {
    return this.torznab.searchMovie(indexer, query, {
      imdbId: media?.imdbId,
      tmdbId: media?.tmdbId,
    });
  }

  private searchQueryForMedia(media: Media): string {
    const { searchTitle } = resolveSearchTitles(media);
    const parts = [searchTitle];
    if (media.year) parts.push(String(media.year));
    return parts.join(' ');
  }

  async searchMovieReleases(
    mediaId: number,
    customQuery?: string,
  ): Promise<MovieReleaseRow[]> {
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['qualityProfile', 'languageProfile'],
    });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);
    if (media.type !== MediaType.MOVIE) {
      throw new BadRequestException(
        'Release search is only available for movies',
      );
    }

    const { allowed, allowedLangs } =
      this.profiles.resolveAllowedForMediaOrThrow(media, 'movie');

    const indexers = await this.indexerRepo.find({
      where: { enabled: true },
      order: { priority: 'ASC', id: 'ASC' },
    });
    if (!indexers.length) {
      this.log.warn(`[searchMovieReleases] no enabled indexers found`);
      return [];
    }
    const ready = this.torznab.filterReadyIndexers(indexers);
    const customTitle = customQuery?.trim();
    const query = customTitle || this.searchQueryForMedia(media);
    this.log.log(
      `[searchMovieReleases] "${media.title}" — query="${query}", indexers=[${ready.map((i) => i.name).join(', ')}]`,
    );
    const batches = await Promise.all(
      ready.map((ix) => this.searchIndexer(ix, query, media)),
    );
    const flat = batches.flat();
    this.log.log(
      `[searchMovieReleases] "${media.title}" — ${flat.length} raw result(s) across ${indexers.length} indexer(s)`,
    );

    const rows = await this.buildMovieReleaseRows(
      flat,
      media,
      indexers,
      allowed,
      allowedLangs,
      customTitle || resolveSearchTitles(media).expectedTitles,
    );
    // Drop releases that overshoot the profile's reach. Profiles have two
    // independent fields — `cutoff` (the auto-grab "good enough" target)
    // and `items[].allowed` (the qualities the user is willing to accept).
    // Filtering by cutoff strips legitimate above-cutoff hits when the
    // user explicitly allows them (e.g. an Ultra HD profile with cutoff
    // left at the WEBDL-1080p default still allows 2160p — those releases
    // must surface). Use the highest allowed rank instead: it still hides
    // 2160p noise from a 1080p-only profile because those IDs aren't in
    // `allowed`.
    const maxRank = maxAllowedRank(allowed);
    const withinProfile = rows.filter((r) => r.rank <= maxRank);
    const accepted = withinProfile.filter((r) => r.rejections.length === 0).length;
    this.log.log(
      `[searchMovieReleases] "${media.title}" — ${withinProfile.length} within profile (rank ≤ ${maxRank}), ${accepted} accepted, ${withinProfile.length - accepted} rejected`,
    );
    if (accepted === 0 && withinProfile.length > 0) {
      const sample = withinProfile
        .slice(0, 5)
        .map(
          (r) =>
            `"${r.title}" [${r.rejections.map(formatRejectionForLog).join(', ')}]`,
        );
      this.log.warn(
        `[searchMovieReleases] all releases rejected — sample: ${sample.join(' | ')}`,
      );
    }

    return sortReleasesByRelevance(withinProfile);
  }

  async grabMovie(
    mediaId: number,
    dto: GrabMovieDto,
  ): Promise<DownloadHistory> {
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['qualityProfile', 'languageProfile'],
    });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);
    if (media.type !== MediaType.MOVIE) {
      throw new BadRequestException(
        'Download grab is only available for movies',
      );
    }
    if (!media.libraryId) {
      throw new BadRequestException(
        'Assign a library to this movie before downloading',
      );
    }

    const { allowed } = this.profiles.resolveAllowedForMediaOrThrow(
      media,
      'movie',
    );

    let downloadUrl = dto.downloadUrl?.trim();
    let sourceTitle = dto.sourceTitle?.trim();
    let indexerId = dto.indexerId;
    const grabSource: 'auto' | 'manual' = downloadUrl ? 'manual' : 'auto';

    this.log.log(
      `grabMovie #${mediaId} "${media.title}" — manual URL: ${downloadUrl || '(auto)'}`,
    );

    if (!downloadUrl) {
      const rows = await this.searchMovieReleases(mediaId);
      const pick =
        rows.find(
          (r) =>
            r.allowed &&
            !r.blocklisted &&
            r.languageAllowed &&
            r.rejections.length === 0,
        ) ?? rows.find((r) => r.allowed && !r.blocklisted && r.languageAllowed);
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
      // Manual grab — still check blocklist
      if (!sourceTitle) sourceTitle = inferTitleFromTorrentUrl(downloadUrl);
      if (await this.blocklist.isBlocked(sourceTitle)) {
        throw new BadRequestException(
          `"${sourceTitle}" is in the blocklist and cannot be downloaded.`,
        );
      }
    }

    const parsed = parseReleaseQuality(sourceTitle);
    if (!allowed.has(parsed.quality.id)) {
      throw new BadRequestException(
        `This release (${parsed.quality.name}) is not allowed by the movie quality profile`,
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
      'movie',
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
        }),
      ),
    );

    void this.host['notifications.dispatch']({
      event: 'grab.started',
      payload: {
        title: media.title,
        quality: parsed.quality.name,
        sourceTitle,
      },
    });

    this.events.emitDomain({ type: 'acquisition.grabbed', mediaId });

    return saved;
  }

  async searchUpgradeReleases(
    mediaId: number,
    customQuery?: string,
  ): Promise<MovieReleaseRow[]> {
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['qualityProfile', 'languageProfile', 'files'],
    });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);
    if (media.type !== MediaType.MOVIE) {
      throw new BadRequestException(
        'Upgrade search is only available for movies',
      );
    }

    const profile = media.qualityProfile;
    if (!profile?.upgradeAllowed) {
      throw new BadRequestException(
        'Upgrade is not enabled for this quality profile',
      );
    }

    const files: { quality: string }[] = (media as any).files ?? [];
    if (!files.length) {
      throw new BadRequestException(
        'No file on disk — use the standard grab instead',
      );
    }

    // Determine current best quality rank among all files
    let currentRank = 0;
    for (const f of files) {
      const parsed = parseReleaseQuality(f.quality);
      if (parsed.quality.rank > currentRank) currentRank = parsed.quality.rank;
    }

    // Cutoff rank — the target quality we stop upgrading at
    const cutoffQuality = getAppQualityById(profile.cutoff);
    const cutoffRank = cutoffQuality?.rank ?? 999;

    if (currentRank >= cutoffRank) {
      return []; // Already at or above cutoff — nothing to upgrade to
    }

    const allowed = this.allowedQualityIds(profile.items);

    const indexers = await this.indexerRepo.find({
      where: { enabled: true },
      order: { priority: 'ASC', id: 'ASC' },
    });
    const customTitle = customQuery?.trim();
    const query = customTitle || this.searchQueryForMedia(media);
    const batches = await Promise.all(
      indexers.map((ix) => this.searchIndexer(ix, query, media)),
    );
    const flat = batches.flat();
    const allowedLangs = allowedAudioLanguageIds(
      media.languageProfile?.audioLanguages,
    );

    const rows = await this.buildMovieReleaseRows(
      flat,
      media,
      indexers,
      allowed,
      allowedLangs,
      customTitle || resolveSearchTitles(media).expectedTitles,
    );

    // Only keep releases that are strictly better than current AND within cutoff
    const currentResolution = profile.resolutionUpgradeOnly
      ? maxResolutionFromQualityStrings(files)
      : 0;
    return sortReleasesByRelevance(
      rows.filter((r) => {
        if (r.rank <= currentRank || r.rank > cutoffRank) return false;
        if (profile.resolutionUpgradeOnly) {
          const releaseResolution = parseReleaseQuality(r.title).quality
            .resolution;
          if (releaseResolution <= currentResolution) return false;
        }
        return true;
      }),
    );
  }

  async grabUpgrade(
    mediaId: number,
    dto: GrabMovieDto,
  ): Promise<DownloadHistory> {
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['qualityProfile', 'languageProfile', 'files'],
    });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);
    if (media.type !== MediaType.MOVIE) {
      throw new BadRequestException(
        'Upgrade grab is only available for movies',
      );
    }
    if (!media.libraryId) {
      throw new BadRequestException(
        'Assign a library to this movie before downloading',
      );
    }

    const profile = media.qualityProfile;
    if (!profile?.upgradeAllowed) {
      throw new BadRequestException(
        'Upgrade is not enabled for this quality profile',
      );
    }

    const files: { quality: string }[] = (media as any).files ?? [];
    if (!files.length) {
      throw new BadRequestException(
        'No file on disk — use the standard grab instead',
      );
    }

    let currentRank = 0;
    for (const f of files) {
      const p = parseReleaseQuality(f.quality);
      if (p.quality.rank > currentRank) currentRank = p.quality.rank;
    }

    const cutoffQuality = getAppQualityById(profile.cutoff);
    const cutoffRank = cutoffQuality?.rank ?? 999;
    const allowed = this.allowedQualityIds(profile.items);

    let downloadUrl = dto.downloadUrl?.trim();
    let sourceTitle = dto.sourceTitle?.trim();
    let indexerId = dto.indexerId;
    const grabSource: 'auto' | 'manual' = downloadUrl ? 'manual' : 'auto';

    this.log.log(
      `grabUpgrade #${mediaId} "${media.title}" — manual URL: ${downloadUrl || '(auto)'}`,
    );

    if (!downloadUrl) {
      const upgrades = await this.searchUpgradeReleases(mediaId);
      const pick =
        upgrades.find(
          (r) =>
            r.allowed &&
            !r.blocklisted &&
            r.languageAllowed &&
            r.rejections.length === 0,
        ) ??
        upgrades.find((r) => r.allowed && !r.blocklisted && r.languageAllowed);
      if (!pick) {
        throw new BadRequestException(
          'No upgrade release found that matches the quality and language profiles',
        );
      }
      downloadUrl = pick.downloadUrl;
      sourceTitle = pick.title;
      indexerId = pick.indexerId;
      this.log.log(`Upgrade auto-picked: "${sourceTitle}" — ${downloadUrl}`);
    } else {
      if (!sourceTitle) sourceTitle = inferTitleFromTorrentUrl(downloadUrl);
      if (await this.blocklist.isBlocked(sourceTitle)) {
        throw new BadRequestException(
          `"${sourceTitle}" is in the blocklist and cannot be downloaded.`,
        );
      }
    }

    const parsed = parseReleaseQuality(sourceTitle);
    if (parsed.quality.rank <= currentRank) {
      throw new BadRequestException(
        `This release (${parsed.quality.name}) is not better than the current quality`,
      );
    }
    if (profile.resolutionUpgradeOnly) {
      const currentResolution = maxResolutionFromQualityStrings(files);
      if (parsed.quality.resolution <= currentResolution) {
        throw new BadRequestException(
          `This release (${parsed.quality.resolution}p) does not increase resolution above the current file (${currentResolution}p)`,
        );
      }
    }
    if (parsed.quality.rank > cutoffRank) {
      throw new BadRequestException(
        `This release (${parsed.quality.name}) exceeds the cutoff quality`,
      );
    }
    if (!allowed.has(parsed.quality.id)) {
      throw new BadRequestException(
        `This release (${parsed.quality.name}) is not allowed by the quality profile`,
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

    this.log.log(
      `Sending upgrade to qBittorrent: "${sourceTitle}" — ${downloadUrl}`,
    );
    const torrentHash = await this.qbittorrent.addTorrentUrl(
      qbit,
      downloadUrl,
      'movie',
    );
    this.log.log(
      `Upgrade grab successful for "${sourceTitle}" (hash=${torrentHash})`,
    );

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
        }),
      ),
    );

    void this.host['notifications.dispatch']({
      event: 'grab.started',
      payload: {
        title: media.title,
        quality: parsed.quality.name,
        sourceTitle,
      },
    });

    return saved;
  }
}
