import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Media } from './entities/media.entity';
import { DownloadHistory } from './entities/download-history.entity';
import { Indexer } from '../indexers/entities/indexer.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { TorznabService, TorznabRelease } from '../indexers/torznab.service';
import { QbittorrentService } from '../download-clients/qbittorrent.service';
import { CustomFormatsService } from '../profiles/custom-formats.service';
import { ProfilesService } from '../profiles/profiles.service';
import { QualityDefinitionsService } from '../profiles/quality-definitions.service';
import { BlocklistService } from '../blocklist/blocklist.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MediaType } from '../../common/enums';
import { GrabMovieDto } from './dto/grab-movie.dto';
import { QualityProfileItem } from '../profiles/entities/quality-profile.entity';
import { getAppQualityById } from '../../common/constants/app-qualities';
import { parseReleaseQuality } from './release-quality.parser';
import {
  ReleaseRejection,
  buildIndexerMinSeeders,
  buildAllowedQualityIds,
  allowedAudioLanguageIds,
  scoreAndSortReleases,
  sortReleasesByRelevance,
} from './release-rejection.helper';

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
    private readonly notifications: NotificationsService,
    private readonly qualityDefs: QualityDefinitionsService,
    private readonly profiles: ProfilesService,
  ) {}

  private allowedQualityIds(
    items: QualityProfileItem[] | undefined,
  ): Set<number> {
    return buildAllowedQualityIds(items);
  }

  private async buildMovieReleaseRows(
    releases: TorznabRelease[],
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
    // the spread TorznabRelease fields.
    return scored as MovieReleaseRow[];
  }

  private searchIndexer(
    indexer: Indexer,
    query: string,
    media?: Media,
  ): Promise<TorznabRelease[]> {
    return this.torznab.searchMovie(indexer, query, {
      imdbId: media?.imdbId,
      tmdbId: media?.tmdbId,
    });
  }

  private searchQueryForMedia(media: Media): string {
    const parts = [media.title];
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
    const customTitle = customQuery?.trim();
    const query = customTitle || this.searchQueryForMedia(media);
    this.log.log(`[searchMovieReleases] "${media.title}" — query="${query}", indexers=[${indexers.map((i) => i.name).join(', ')}]`);
    const batches = await Promise.all(
      indexers.map((ix) => this.searchIndexer(ix, query, media)),
    );
    const flat = batches.flat();
    this.log.log(`[searchMovieReleases] "${media.title}" — ${flat.length} raw result(s) across ${indexers.length} indexer(s)`);

    const rows = await this.buildMovieReleaseRows(
      flat,
      media,
      indexers,
      allowed,
      allowedLangs,
      customTitle || [media.title, ...(media.alternativeTitles ?? [])],
    );
    const accepted = rows.filter((r) => r.rejections.length === 0).length;
    this.log.log(`[searchMovieReleases] "${media.title}" — ${rows.length} scored, ${accepted} accepted, ${rows.length - accepted} rejected`);
    if (accepted === 0 && rows.length > 0) {
      const sample = rows.slice(0, 5).map((r) => `"${r.title}" [${r.rejections.join(', ')}]`);
      this.log.warn(`[searchMovieReleases] all releases rejected — sample: ${sample.join(' | ')}`);
    }

    return sortReleasesByRelevance(rows);
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
    if (!media.rootFolderId) {
      throw new BadRequestException(
        'Assign a root folder to this movie before downloading',
      );
    }

    const { allowed } = this.profiles.resolveAllowedForMediaOrThrow(
      media,
      'movie',
    );

    let downloadUrl = dto.downloadUrl?.trim();
    let sourceTitle = dto.sourceTitle?.trim();
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

    const row = this.historyRepo.create({
      media,
      downloadClient: qbit,
      sourceTitle,
      torrentHash: torrentHash || undefined,
      quality: parsed.quality.name,
      status: 'grabbed',
      grabSource,
    });
    const saved = await this.historyRepo.save(row);

    void this.notifications.dispatch('grab.started', {
      title: media.title,
      quality: parsed.quality.name,
      sourceTitle,
    });

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
      customTitle || [media.title, ...(media.alternativeTitles ?? [])],
    );

    // Only keep releases that are strictly better than current AND within cutoff
    return sortReleasesByRelevance(
      rows.filter((r) => r.rank > currentRank && r.rank <= cutoffRank),
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
    if (!media.rootFolderId) {
      throw new BadRequestException(
        'Assign a root folder to this movie before downloading',
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

    const row = this.historyRepo.create({
      media,
      downloadClient: qbit,
      sourceTitle,
      torrentHash: torrentHash || undefined,
      quality: parsed.quality.name,
      status: 'grabbed',
      grabSource,
    });
    const saved = await this.historyRepo.save(row);

    void this.notifications.dispatch('grab.started', {
      title: media.title,
      quality: parsed.quality.name,
      sourceTitle,
    });

    return saved;
  }
}
