import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Command } from './entities/command.entity';
import { Media } from '../media/entities/media.entity';
import { DownloadHistory } from '../media/entities/download-history.entity';
import { Season } from '../media/entities/season.entity';
import { Episode } from '../media/entities/episode.entity';
import { Indexer } from '../indexers/entities/indexer.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { TorznabService } from '../indexers/torznab.service';
import { QbittorrentService } from '../download-clients/qbittorrent.service';
import { TmdbProvider } from '../metadata-providers/providers/tmdb.provider';
import { MediaService } from '../media/media.service';
import { MediaType, MediaStatus, MinimumAvailability } from '../../common/enums';
import { ConfigService } from '@nestjs/config';
import { CompletionService } from './completion.service';
import { NamingService } from './naming.service';
import { DelayProfile } from '../profiles/entities/delay-profile.entity';
import { EventsService } from './events.service';

@Injectable()
export class SchedulerService {
  private readonly log = new Logger(SchedulerService.name);

  constructor(
    @InjectRepository(Command)
    private readonly commandRepo: Repository<Command>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(DownloadHistory)
    private readonly historyRepo: Repository<DownloadHistory>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
    @InjectRepository(DownloadClient)
    private readonly clientRepo: Repository<DownloadClient>,
    private readonly torznab: TorznabService,
    private readonly qbittorrent: QbittorrentService,
    private readonly tmdb: TmdbProvider,
    private readonly mediaService: MediaService,
    private readonly config: ConfigService,
    private readonly completion: CompletionService,
    private readonly naming: NamingService,
    @InjectRepository(DelayProfile)
    private readonly delayProfileRepo: Repository<DelayProfile>,
    private readonly eventsService: EventsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Scheduled jobs
  // ---------------------------------------------------------------------------

  /** Search for missing monitored movies every 6 hours */
  @Cron(CronExpression.EVERY_6_HOURS)
  async searchMissing(): Promise<void> {
    return this.runCommand('SearchMissing', 'scheduled', () =>
      this.doSearchMissing(),
    );
  }

  /** Refresh metadata for all media once a day */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async refreshMetadata(): Promise<void> {
    return this.runCommand('RefreshMetadata', 'scheduled', () =>
      this.doRefreshMetadata(),
    );
  }

  /** RSS sync every 15 minutes */
  @Cron('*/15 * * * *')
  async rssSync(): Promise<void> {
    return this.runCommand('RssSync', 'scheduled', () => this.doRssSync());
  }

  // ---------------------------------------------------------------------------
  // Manual trigger
  // ---------------------------------------------------------------------------

  async triggerCommand(name: string): Promise<Command> {
    const known = ['SearchMissing', 'RefreshMetadata', 'RssSync', 'ImportCompleted'];
    if (!known.includes(name)) {
      throw new Error(`Unknown command: ${name}. Valid: ${known.join(', ')}`);
    }

    const cmd = await this.commandRepo.save(
      this.commandRepo.create({ name, status: 'queued', trigger: 'manual' }),
    );

    // Fire-and-forget, do not await
    this.dispatchCommand(name, cmd.id).catch((e) =>
      this.log.error(`Command ${name} failed: ${e.message}`),
    );

    return cmd;
  }

  getRecentCommands(limit = 50): Promise<Command[]> {
    return this.commandRepo.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async runCommand(
    name: string,
    trigger: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const cmd = await this.commandRepo.save(
      this.commandRepo.create({ name, status: 'running', trigger, startedOn: new Date() }),
    );
    try {
      await fn();
      cmd.status = 'completed';
    } catch (e) {
      this.log.error(`Command ${name} error: ${(e as Error).message}`);
      cmd.status = 'failed';
    } finally {
      cmd.endedOn = new Date();
      await this.commandRepo.save(cmd);
    }
  }

  private async dispatchCommand(name: string, cmdId: number): Promise<void> {
    await this.commandRepo.update(cmdId, { status: 'running', startedOn: new Date() });
    try {
      if (name === 'SearchMissing') await this.doSearchMissing();
      else if (name === 'RefreshMetadata') await this.doRefreshMetadata();
      else if (name === 'RssSync') await this.doRssSync();
      else if (name === 'ImportCompleted') await this.completion.processCompleted();
      await this.commandRepo.update(cmdId, { status: 'completed', endedOn: new Date() });
    } catch (e) {
      await this.commandRepo.update(cmdId, { status: 'failed', endedOn: new Date() });
      throw e;
    }
  }

  private async doSearchMissing(): Promise<void> {
    const indexers = await this.indexerRepo.find({
      where: { enabled: true },
      order: { priority: 'ASC' },
    });
    const clients = await this.clientRepo.find({ where: { enabled: true } });
    const qbitClient = clients.find((c) => this.qbittorrent.supports(c));

    if (!indexers.length || !qbitClient) {
      this.log.warn('SearchMissing: no enabled indexers or download client');
      return;
    }

    await this.searchMissingMovies(indexers, qbitClient);
    await this.searchMissingEpisodes(indexers, qbitClient);
  }

  private async searchMissingMovies(
    indexers: Indexer[],
    qbitClient: DownloadClient,
  ): Promise<void> {
    const missing = await this.mediaRepo
      .createQueryBuilder('m')
      .leftJoin('m.files', 'f')
      .where('m.monitored = true')
      .andWhere('m.type = :type', { type: MediaType.MOVIE })
      .andWhere('f.id IS NULL')
      .getMany();

    if (!missing.length) return;

    const today = new Date().toISOString().slice(0, 10);
    this.eventsService.emit({ command: 'SearchMissing', current: 0, total: missing.length, message: 'Searching movies...' });

    for (let i = 0; i < missing.length; i++) {
      const media = missing[i];
      // Skip if availability criteria not met
      if (!this.isAvailable(media, today)) {
        this.eventsService.emit({ command: 'SearchMissing', current: i + 1, total: missing.length, message: media.title });
        continue;
      }

      // Skip if already grabbed and pending
      const pending = await this.historyRepo.findOne({
        where: { mediaId: media.id, status: 'grabbed' },
      });
      if (pending) {
        this.eventsService.emit({ command: 'SearchMissing', current: i + 1, total: missing.length, message: media.title });
        continue;
      }

      const query = [media.title, media.year].filter(Boolean).join(' ');
      const batches = await Promise.allSettled(
        indexers.map((ix) => this.torznab.searchMovie(ix, query)),
      );
      const results = batches.flatMap((r) =>
        r.status === 'fulfilled' ? r.value : [],
      );
      if (!results.length) {
        this.eventsService.emit({ command: 'SearchMissing', current: i + 1, total: missing.length, message: media.title });
        continue;
      }

      const pick = results[0];
      try {
        await this.qbittorrent.addTorrentUrl(qbitClient, pick.downloadUrl, 'movie');
        await this.historyRepo.save(
          this.historyRepo.create({
            mediaId: media.id,
            downloadClientId: qbitClient.id,
            indexerId: pick.indexerId,
            sourceTitle: pick.title,
            quality: this.naming.parseQuality(pick.title),
            status: 'grabbed',
          }),
        );
        this.log.log(`SearchMissing[movie]: grabbed "${pick.title}" for "${media.title}"`);
      } catch (e) {
        this.log.warn(`SearchMissing[movie]: grab failed for "${media.title}": ${(e as Error).message}`);
      }
      this.eventsService.emit({ command: 'SearchMissing', current: i + 1, total: missing.length, message: media.title });
    }
  }

  private async searchMissingEpisodes(
    indexers: Indexer[],
    qbitClient: DownloadClient,
  ): Promise<void> {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Find monitored series with monitored, un-downloaded, aired episodes
    const episodes = await this.episodeRepo
      .createQueryBuilder('ep')
      .innerJoin('ep.season', 'season')
      .innerJoin('season.media', 'media')
      .where('media.monitored = true')
      .andWhere('media.type = :type', { type: MediaType.SERIES })
      .andWhere('season.monitored = true')
      .andWhere('ep.monitored = true')
      .andWhere('ep.hasFile = false')
      .andWhere('ep.airDate IS NOT NULL')
      .andWhere('ep.airDate <= :today', { today })
      .select(['ep.id', 'ep.episodeNumber', 'ep.title', 'ep.airDate'])
      .addSelect(['season.id', 'season.seasonNumber', 'season.mediaId'])
      .addSelect(['media.id', 'media.title', 'media.year'])
      .getMany();

    if (!episodes.length) return;

    this.eventsService.emit({ command: 'SearchMissing', current: 0, total: episodes.length, message: 'Searching episodes...' });

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const season = (ep as any).season as Season;
      const media = (season as any).media as Media;

      // Skip if already grabbed
      const pending = await this.historyRepo
        .createQueryBuilder('h')
        .where('h.mediaId = :mediaId', { mediaId: media.id })
        .andWhere('h.status = :status', { status: 'grabbed' })
        .andWhere(`h.sourceTitle ILIKE :pattern`, {
          pattern: `%S${String(season.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}%`,
        })
        .getOne();
      if (pending) {
        this.eventsService.emit({ command: 'SearchMissing', current: i + 1, total: episodes.length, message: media.title });
        continue;
      }

      const batches = await Promise.allSettled(
        indexers.map((ix) =>
          this.torznab.searchSeries(ix, media.title, season.seasonNumber, ep.episodeNumber),
        ),
      );
      const results = batches.flatMap((r) =>
        r.status === 'fulfilled' ? r.value : [],
      );
      if (!results.length) {
        this.eventsService.emit({ command: 'SearchMissing', current: i + 1, total: episodes.length, message: media.title });
        continue;
      }

      const pick = results[0];
      try {
        await this.qbittorrent.addTorrentUrl(qbitClient, pick.downloadUrl, 'series');
        await this.historyRepo.save(
          this.historyRepo.create({
            mediaId: media.id,
            downloadClientId: qbitClient.id,
            indexerId: pick.indexerId,
            sourceTitle: pick.title,
            quality: this.naming.parseQuality(pick.title),
            status: 'grabbed',
          }),
        );
        const epLabel = `S${String(season.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`;
        this.log.log(`SearchMissing[series]: grabbed "${pick.title}" for "${media.title}" ${epLabel}`);
      } catch (e) {
        this.log.warn(
          `SearchMissing[series]: grab failed for "${media.title}" ep ${ep.id}: ${(e as Error).message}`,
        );
      }
      this.eventsService.emit({ command: 'SearchMissing', current: i + 1, total: episodes.length, message: media.title });
    }
  }

  private async doRefreshMetadata(): Promise<void> {
    const apiKey = this.config.get<string>('TMDB_API_KEY', '');
    if (!apiKey?.trim()) {
      this.log.warn('RefreshMetadata: TMDB_API_KEY not configured');
      return;
    }

    const allMedia = await this.mediaRepo.find({ where: { monitored: true } });
    let updated = 0;

    this.eventsService.emit({ command: 'RefreshMetadata', current: 0, total: allMedia.length, message: 'Refreshing metadata...' });

    for (let i = 0; i < allMedia.length; i++) {
      const media = allMedia[i];
      try {
        await this.mediaService.refreshMetadata(media.id);
        updated++;
      } catch (e) {
        this.log.warn(`RefreshMetadata: failed for "${media.title}": ${(e as Error).message}`);
      }
      this.eventsService.emit({ command: 'RefreshMetadata', current: i + 1, total: allMedia.length, message: media.title });
    }

    this.log.log(`RefreshMetadata: updated ${updated}/${allMedia.length} titles`);
  }

  private async doRssSync(): Promise<void> {
    const indexers = await this.indexerRepo.find({
      where: { enabled: true, enableRss: true },
      order: { priority: 'ASC' },
    });

    if (!indexers.length) return;

    // Collect monitored movie titles for matching
    const monitored = await this.mediaRepo.find({
      where: { monitored: true, type: MediaType.MOVIE },
      select: ['id', 'title', 'year'],
      relations: ['tags'],
    });
    const clients = await this.clientRepo.find({ where: { enabled: true } });
    const qbitClient = clients.find((c) => this.qbittorrent.supports(c));
    if (!qbitClient) return;

    const delayProfiles = await this.delayProfileRepo.find({ order: { order: 'ASC' } });

    this.eventsService.emit({ command: 'RssSync', current: 0, total: indexers.length, message: 'RSS sync...' });

    for (let i = 0; i < indexers.length; i++) {
      const indexer = indexers[i];
      try {
        const results = await this.torznab.rssSearch(indexer);
        for (const release of results) {
          const match = monitored.find((m) =>
            release.title.toLowerCase().includes(m.title.toLowerCase()),
          );
          if (!match) continue;

          // Check delay profile
          if (release.publishDate && this.isDelayed(match, release.publishDate, delayProfiles)) continue;

          // Check if already in history
          const alreadyGrabbed = await this.historyRepo.findOne({
            where: { mediaId: match.id, sourceTitle: release.title },
          });
          if (alreadyGrabbed) continue;

          try {
            await this.qbittorrent.addTorrentUrl(qbitClient, release.downloadUrl, 'movie');
            await this.historyRepo.save(
              this.historyRepo.create({
                mediaId: match.id,
                downloadClientId: qbitClient.id,
                indexerId: release.indexerId,
                sourceTitle: release.title,
                quality: this.naming.parseQuality(release.title),
                status: 'grabbed',
              }),
            );
            this.log.log(`RssSync: grabbed "${release.title}" for "${match.title}"`);
          } catch {
            // ignore individual grab errors
          }
        }
      } catch (e) {
        this.log.warn(`RssSync: indexer "${indexer.name}" failed: ${(e as Error).message}`);
      }
      this.eventsService.emit({ command: 'RssSync', current: i + 1, total: indexers.length, message: indexer.name });
    }
  }

  private isDelayed(media: Media, publishDate: string, delayProfiles: DelayProfile[]): boolean {
    if (!delayProfiles.length) return false;
    const mediaTags = new Set((media.tags ?? []).map((t) => t.id));
    // Find the first matching delay profile (by tag intersection, or empty tags = matches all)
    const profile = delayProfiles.find((dp) => {
      if (!dp.tags?.length) return true; // no tags = global default
      return dp.tags.some((t) => mediaTags.has(t.id));
    });
    if (!profile || profile.torrentDelay <= 0) return false;
    const ageHours = (Date.now() - new Date(publishDate).getTime()) / 3_600_000;
    return ageHours < profile.torrentDelay;
  }

  private isAvailable(media: Media, today: string): boolean {
    switch (media.minimumAvailability) {
      case MinimumAvailability.ANNOUNCED:
        return true;
      case MinimumAvailability.IN_CINEMAS:
        return !!(media.inCinemas && media.inCinemas <= today);
      case MinimumAvailability.RELEASED:
        return !!(
          (media.digitalRelease && media.digitalRelease <= today) ||
          (media.physicalRelease && media.physicalRelease <= today)
        );
      default:
        return true;
    }
  }
}
