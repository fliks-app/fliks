import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import { Media } from '../../modules/media/entities/media.entity';
import {
  AutoGrabPipelineService,
  AutoGrabScoringContext,
} from '../../modules/media/auto-grab-pipeline.service';
import {
  AcquisitionCandidatesService,
  SeasonPackTarget,
} from '../../modules/media/acquisition-candidates.service';
import { onDiskEpisodeNumbers } from '../../modules/media/episode-coverage.util';
import { EventsService } from '../../modules/scheduler/events.service';
import { DelayProfile } from '../../modules/profiles/entities/delay-profile.entity';
import {
  MediaStatus,
  MediaType,
  MinimumAvailability,
} from '../../common/enums';
import {
  ReleaseCandidate,
  releaseMatchesMedia,
  resolveSearchTitles,
} from '../../common/release-scoring';
import {
  parseSeasonEpisode,
  matchesSeasonPack,
} from '../../common/release-parsing';
import { DownloadHistory } from './entities/download-history.entity';
import { Indexer } from './indexers/entities/indexer.entity';
import { DownloadClient } from './download-clients/entities/download-client.entity';
import { TorznabService } from './indexers/torznab.service';
import { QbittorrentService } from './download-clients/qbittorrent.service';
import { AutoGrabExecutorService } from './auto-grab-pipeline.service';

/**
 * SearchMissing / RssSync cron bodies and the per-candidate indexer fan-out.
 * Triggered by `SchedulerService`, which owns the `@Cron` decorators, the
 * Command audit trail and the manual-trigger dispatch.
 */
@Injectable()
export class AcquisitionSchedulerService implements OnModuleInit {
  private readonly log = new Logger(AcquisitionSchedulerService.name);
  private readonly subscriptions = new Subscription();

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(DownloadHistory)
    private readonly historyRepo: Repository<DownloadHistory>,
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
    @InjectRepository(DownloadClient)
    private readonly clientRepo: Repository<DownloadClient>,
    @InjectRepository(DelayProfile)
    private readonly delayProfileRepo: Repository<DelayProfile>,
    private readonly torznab: TorznabService,
    private readonly qbittorrent: QbittorrentService,
    private readonly autoGrab: AutoGrabPipelineService,
    private readonly autoGrabExec: AutoGrabExecutorService,
    private readonly candidates: AcquisitionCandidatesService,
    private readonly eventsService: EventsService,
  ) {}

  onModuleInit(): void {
    // Single subscriber for every acquisition-side trigger — see the five
    // `media.acquisition.requested` emitters across media/download-clients/requests.
    this.subscriptions.add(
      this.eventsService.onDomain((event) => {
        if (event.type !== 'media.acquisition.requested') return;
        void this.searchMissingForMedia(event.mediaIds);
      }),
    );
  }

  /**
   * Targeted, fire-and-forget search for one or more media ids. Used
   * by the request lifecycle right after an approval-driven import so
   * the user doesn't wait for the next scheduled SearchMissing tick
   * (up to 6 h). Bypasses the Command row on purpose — the audit
   * trail for this trigger lives on the request itself, an extra
   * Command per approval would just clutter the history.
   *
   * Throws on infra misconfiguration (no indexer, no download client)
   * are swallowed and logged: a botched auto-trigger shouldn't take
   * down the approval transaction.
   */
  private async searchMissingForMedia(mediaIds: number[]): Promise<void> {
    if (mediaIds.length === 0) return;
    try {
      await this.searchMissing(mediaIds);
    } catch (e) {
      this.log.warn(
        `searchMissingForMedia([${mediaIds.join(', ')}]) failed: ${(e as Error).message}`,
      );
    }
  }

  // Only logs when a targeted (request-driven) SearchMissing kicks off,
  // so scheduled bulk runs don't get noisy. The hint tells the user what
  // the candidate query is filtering on when the count is zero.
  private logTargetedCandidateCount(
    scope: 'movies' | 'episodes',
    mediaIds: number[] | undefined,
    count: number,
  ): void {
    if (!mediaIds?.length) return;
    if (count > 0) {
      this.log.log(
        `SearchMissing[${scope}]: ${count} candidate(s) for media IDs [${mediaIds.join(', ')}]`,
      );
      return;
    }
    const hint =
      scope === 'movies'
        ? "check monitored flag, type=movie, and that there's no file already at cutoff"
        : 'check that the series/seasons/episodes are monitored and have an airDate ≤ today';
    this.log.log(
      `SearchMissing[${scope}]: 0 candidates for media IDs [${mediaIds.join(', ')}] — ${hint}`,
    );
  }

  /**
   * Drop indexers in failure / Retry-After cooldown before an auto-grab
   * fan-out, mirroring the interactive search paths. A cooled-down indexer
   * left in the list makes the throttle sleep its queued call out for the
   * full backoff (up to 6h); since the fan-out awaits every indexer, one
   * broken host stalls the whole `Promise.allSettled` and the grab step
   * never runs. Returns [] when every indexer is cooling.
   */
  private readyIndexersOrNone(indexers: Indexer[], context: string): Indexer[] {
    const ready = this.torznab.filterReadyIndexers(indexers);
    if (!ready.length) {
      this.log.warn(
        `${context}: every indexer is in cooldown — skipping this run`,
      );
    }
    return ready;
  }

  async searchMissing(mediaIds?: number[]): Promise<void> {
    if (mediaIds?.length) {
      this.log.log(
        `SearchMissing: targeted restart for media IDs [${mediaIds.join(', ')}]`,
      );
    }
    const enabledIndexers = await this.indexerRepo.find({
      where: { enabled: true },
      order: { priority: 'ASC' },
    });
    const clients = await this.clientRepo.find({ where: { enabled: true } });
    const qbitClient = clients.find((c) => this.qbittorrent.supports(c));

    if (!enabledIndexers.length) {
      throw new Error('No enabled indexers configured');
    }
    if (!qbitClient) {
      throw new Error('No enabled download client configured');
    }

    const connCheck = await this.qbittorrent.testConnection(
      qbitClient.settings,
    );
    if (!connCheck.ok) {
      throw new Error(`Download client unreachable — ${connCheck.message}`);
    }

    const indexers = this.readyIndexersOrNone(enabledIndexers, 'SearchMissing');
    if (!indexers.length) return;

    await this.searchMissingMovies(indexers, qbitClient, mediaIds);
    await this.searchMissingEpisodes(indexers, qbitClient, mediaIds);
  }

  private async searchMissingMovies(
    indexers: Indexer[],
    qbitClient: DownloadClient,
    mediaIds?: number[],
  ): Promise<void> {
    const targets = await this.candidates.listMovieTargets(mediaIds);

    this.logTargetedCandidateCount('movies', mediaIds, targets.length);
    if (!targets.length) return;

    const today = new Date().toISOString().slice(0, 10);
    const scoring = await this.autoGrab.buildScoringContext(indexers);

    for (let i = 0; i < targets.length; i++) {
      const { media, files } = targets[i];
      this.eventsService.emit({
        type: 'task.progress',
        command: 'SearchMissing',
        current: i,
        total: targets.length,
        message: media.title,
      });

      if (!this.isAvailable(media, today)) continue;

      const { searchTitle } = resolveSearchTitles(media);
      const query = [searchTitle, media.year].filter(Boolean).join(' ');
      const batches = await Promise.allSettled(
        indexers.map((ix) =>
          this.torznab.searchMovie(ix, query, {
            imdbId: media.imdbId,
            tmdbId: media.tmdbId,
          }),
        ),
      );
      const releases = batches
        .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
        .filter((r) =>
          releaseMatchesMedia(r.title, media, { requireYearInTitle: true }),
        );

      await this.autoGrabExec.tryAutoGrab({
        media,
        files,
        releases,
        qbitClient,
        scoring,
        mediaType: 'movie',
        label: media.title,
        runtimeMinutes: media.runtime ?? 0,
        pendingCheck: async () => {
          const pending = await this.historyRepo.findOne({
            where: { media: { id: media.id }, status: 'grabbed' },
          });
          return !!pending;
        },
      });
    }

    this.eventsService.emit({
      type: 'task.progress',
      command: 'SearchMissing',
      current: targets.length,
      total: targets.length,
      message: 'SearchMissing',
    });
  }

  private async searchMissingEpisodes(
    indexers: Indexer[],
    qbitClient: DownloadClient,
    mediaIds?: number[],
  ): Promise<void> {
    const scoring = await this.autoGrab.buildScoringContext(indexers);

    const targets = await this.candidates.listEpisodeTargets(mediaIds);

    this.logTargetedCandidateCount('episodes', mediaIds, targets.length);
    if (!targets.length) return;

    // Season-pack-first: a season missing more than one episode is better
    // served by one (usually far better seeded) pack than by scattered
    // per-episode grabs. Episodes a grabbed pack covers drop out of the
    // per-episode search below.
    const packTargets = await this.candidates.groupIntoSeasonPacks(targets);
    const coveredByPack = await this.grabMissingSeasonPacks(
      packTargets,
      indexers,
      qbitClient,
      scoring,
    );
    const toSearch = coveredByPack.size
      ? targets.filter((t) => !coveredByPack.has(t.episode.id))
      : targets;

    for (let i = 0; i < toSearch.length; i++) {
      const { media, season, episode: ep, files } = toSearch[i];
      const epLabel = `S${String(season.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`;

      this.eventsService.emit({
        type: 'task.progress',
        command: 'SearchMissing',
        current: i,
        total: toSearch.length,
        message: `${media.title} ${epLabel}`,
      });

      const { searchTitle } = resolveSearchTitles(media);
      const batches = await Promise.allSettled(
        indexers.map((ix) =>
          this.torznab.searchSeries(
            ix,
            searchTitle,
            season.seasonNumber,
            ep.episodeNumber,
            { tvdbId: media.tvdbId, imdbId: media.imdbId },
          ),
        ),
      );
      const releases = batches.flatMap((r) =>
        r.status === 'fulfilled' ? r.value : [],
      );

      await this.autoGrabExec.tryAutoGrab({
        media,
        files,
        releases,
        qbitClient,
        scoring,
        mediaType: 'series',
        label: `${media.title} ${epLabel}`,
        // Episodes are typically 20-60 min; 30 min fallback for size check.
        runtimeMinutes: media.runtime ?? 30,
        seasonNumber: season.seasonNumber,
        episodeNumber: ep.episodeNumber,
        seasonId: season.id,
        episodeId: ep.id,
        pendingCheck: async () => {
          const pending = await this.historyRepo
            .createQueryBuilder('h')
            .where('h.mediaId = :mediaId', { mediaId: media.id })
            .andWhere('h.status = :status', { status: 'grabbed' })
            .andWhere(`h.sourceTitle ILIKE :pattern`, {
              pattern: `%${epLabel}%`,
            })
            .getOne();
          return !!pending;
        },
      });
    }

    this.eventsService.emit({
      type: 'task.progress',
      command: 'SearchMissing',
      current: toSearch.length,
      total: toSearch.length,
      message: 'SearchMissing',
    });
  }

  /**
   * Season-pack-first pass for SearchMissing. For each candidate pack, tries
   * to grab a single full-season release instead of scattered per-episode
   * releases — packs are usually far better seeded and import per-file.
   * Returns the ids of the episodes a grabbed pack now covers so the caller
   * skips their per-episode search.
   */
  private async grabMissingSeasonPacks(
    packs: SeasonPackTarget[],
    indexers: Indexer[],
    qbitClient: DownloadClient,
    scoring: AutoGrabScoringContext,
  ): Promise<Set<number>> {
    const covered = new Set<number>();

    for (const {
      season,
      media,
      episodes: eps,
      files,
      totalEpisodeCount,
    } of packs) {
      const seasonLabel = `S${String(season.seasonNumber).padStart(2, '0')}`;

      // A grabbed pack records a season-scoped history row (no episodeId). If
      // one is already downloading, the episodes are already covered: mark
      // them so the per-episode pass doesn't grab singles alongside the pack
      // (that pass keys off the episode tag, which a pack title doesn't carry).
      const packPending = await this.historyRepo
        .createQueryBuilder('h')
        .where('h.mediaId = :mediaId', { mediaId: media.id })
        .andWhere('h.status = :status', { status: 'grabbed' })
        .andWhere('h.seasonId = :seasonId', { seasonId: season.id })
        .andWhere('h.episodeId IS NULL')
        .getOne();
      if (packPending) {
        for (const ep of eps) covered.add(ep.id);
        continue;
      }

      const { searchTitle } = resolveSearchTitles(media);
      const packBatches = await Promise.allSettled(
        indexers.map((ix) =>
          this.torznab.searchSeasonPack(ix, searchTitle, season.seasonNumber, {
            tvdbId: media.tvdbId,
            imdbId: media.imdbId,
          }),
        ),
      );
      // Indexer `season=` filtering is unreliable (notably text-mode
      // backends), so keep only releases that parse as a full-season pack —
      // never a stray single episode that slipped into the result set.
      const packReleases = packBatches
        .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
        .filter((r) => matchesSeasonPack(r.title, season.seasonNumber));
      if (!packReleases.length) continue;

      const grabbed = await this.autoGrabExec.tryAutoGrab({
        media,
        files,
        releases: packReleases,
        qbitClient,
        scoring,
        mediaType: 'series',
        label: `${media.title} ${seasonLabel} (pack)`,
        runtimeMinutes: (media.runtime ?? 45) * totalEpisodeCount,
        seasonNumber: season.seasonNumber,
        seasonId: season.id,
      });
      if (grabbed) {
        for (const ep of eps) covered.add(ep.id);
        this.log.log(
          `SearchMissing: grabbed a ${media.title} ${seasonLabel} pack covering ${eps.length} missing episode(s)`,
        );
      }
    }

    return covered;
  }

  async rssSync(): Promise<void> {
    const enabledIndexers = await this.indexerRepo.find({
      where: { enabled: true, enableRss: true },
      order: { priority: 'ASC' },
    });

    if (!enabledIndexers.length) return;

    const indexers = this.readyIndexersOrNone(enabledIndexers, 'RssSync');
    if (!indexers.length) return;

    // Full candidates (with profiles + files) so RSS reuses the exact same
    // missing/upgrade pipeline as SearchMissing: title match → classify →
    // score → autoGrabAndRecord. Series candidates also include seasons +
    // episodes so we can match a release against the right `(season, ep)`
    // and apply the season-pack-first priority logic below.
    const movieCandidates = await this.mediaRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.qualityProfile', 'qp')
      .leftJoinAndSelect('m.languageProfile', 'lp')
      .leftJoinAndSelect('m.files', 'f')
      .where('m.monitored = true')
      .andWhere('m.type = :type', { type: MediaType.MOVIE })
      .andWhere('(f.id IS NULL OR qp."upgradeAllowed" = true)')
      .getMany();

    const seriesCandidates = await this.mediaRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.qualityProfile', 'qp')
      .leftJoinAndSelect('m.languageProfile', 'lp')
      .leftJoinAndSelect('m.seasons', 's')
      .leftJoinAndSelect('s.episodes', 'e')
      .where('m.monitored = true')
      .andWhere('m.type = :type', { type: MediaType.SERIES })
      .getMany();

    const clients = await this.clientRepo.find({ where: { enabled: true } });
    const qbitClient = clients.find((c) => this.qbittorrent.supports(c));
    if (!qbitClient) {
      throw new Error('No enabled download client configured');
    }

    const connCheck = await this.qbittorrent.testConnection(
      qbitClient.settings,
    );
    if (!connCheck.ok) {
      throw new Error(`Download client unreachable — ${connCheck.message}`);
    }

    const scoring = await this.autoGrab.buildScoringContext(indexers);
    const delayProfiles = await this.delayProfileRepo.find({
      order: { order: 'ASC' },
    });
    const today = new Date().toISOString().slice(0, 10);

    for (let i = 0; i < indexers.length; i++) {
      const indexer = indexers[i];
      this.eventsService.emit({
        type: 'task.progress',
        command: 'RssSync',
        current: i,
        total: indexers.length,
        message: indexer.name,
      });
      try {
        const results = await this.torznab.rssSearch(indexer);
        // Phase 1: within this feed pull, season packs win over individual
        // episodes of the same season. Sort packs first; track packs we
        // hand to autoGrab so subsequent same-season episodes are skipped.
        const sorted = [...results].sort((a, b) => {
          const pa = parseSeasonEpisode(a.title);
          const pb = parseSeasonEpisode(b.title);
          if (pa.isFullSeason !== pb.isFullSeason)
            return pa.isFullSeason ? -1 : 1;
          const da = a.publishDate ? new Date(a.publishDate).getTime() : 0;
          const db = b.publishDate ? new Date(b.publishDate).getTime() : 0;
          return db - da;
        });
        const packTriedThisPull = new Set<string>();
        for (const release of sorted) {
          const parsed = parseSeasonEpisode(release.title);
          const movieMatch = this.matchMovieRelease(release, movieCandidates);
          if (movieMatch) {
            // Same availability gate as SearchMissing: don't grab a title
            // that hasn't reached its minimum availability yet.
            if (!this.isAvailable(movieMatch, today)) continue;
            if (this.releaseTooFresh(release, movieMatch, delayProfiles))
              continue;
            await this.grabRssRelease({
              media: movieMatch,
              files: movieMatch.files ?? [],
              release,
              qbitClient,
              scoring,
              mediaType: 'movie',
              label: movieMatch.title,
              runtimeMinutes: movieMatch.runtime ?? 0,
              extraPendingCheck: async () => {
                const pending = await this.historyRepo.findOne({
                  where: { media: { id: movieMatch.id }, status: 'grabbed' },
                });
                return !!pending;
              },
            });
            continue;
          }

          // Series — require a recognisable season; no year guard (shows
          // span multiple years).
          if (parsed.season == null) continue;
          const seriesMatch = this.matchSeriesRelease(
            release,
            seriesCandidates,
          );
          if (!seriesMatch) continue;
          const season = seriesMatch.seasons?.find(
            (s) => s.seasonNumber === parsed.season,
          );
          if (!season) continue;
          const packKey = `${seriesMatch.id}:${parsed.season}`;
          const onDiskNums = onDiskEpisodeNumbers(season.episodes ?? []);

          if (parsed.isFullSeason) {
            // A pack is only worth grabbing when it covers a monitored,
            // not-on-disk episode that has already aired — mirroring the
            // airDate gate SearchMissing applies per episode.
            const wanted = (season.episodes ?? []).some(
              (e) =>
                e.monitored &&
                !onDiskNums.has(e.episodeNumber) &&
                !!e.airDate &&
                e.airDate <= today,
            );
            if (!wanted) continue;
            packTriedThisPull.add(packKey);
            await this.grabRssRelease({
              media: seriesMatch,
              files: [],
              release,
              qbitClient,
              scoring,
              mediaType: 'series',
              label: `${seriesMatch.title} S${String(parsed.season).padStart(2, '0')}`,
              runtimeMinutes: seriesMatch.runtime ?? 30,
              seasonNumber: parsed.season,
              extraPendingCheck: () =>
                this.hasRecentSeasonPackGrab(seriesMatch.id, parsed.season!),
            });
            continue;
          }

          if (parsed.episode == null) continue;
          const ep = (season.episodes ?? []).find(
            (e) => e.episodeNumber === parsed.episode,
          );
          if (!ep || !ep.monitored || onDiskNums.has(ep.episodeNumber))
            continue;
          // Don't grab an episode that hasn't aired yet — same airDate gate
          // SearchMissing enforces in its query.
          if (!ep.airDate || ep.airDate > today) continue;
          // Intra-pull Phase 1: a pack for this season was already handed
          // off above; skip the individual episode.
          if (packTriedThisPull.has(packKey)) continue;
          // Phase 2: give a pack time to appear before grabbing a single
          // episode. The DelayProfile's torrentDelay (hours) is the
          // grace window measured against the release's publishDate.
          if (this.releaseTooFresh(release, seriesMatch, delayProfiles))
            continue;
          const epLabel = `S${String(parsed.season).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}`;
          await this.grabRssRelease({
            media: seriesMatch,
            files: [],
            release,
            qbitClient,
            scoring,
            mediaType: 'series',
            label: `${seriesMatch.title} ${epLabel}`,
            runtimeMinutes: seriesMatch.runtime ?? 30,
            seasonNumber: parsed.season,
            extraPendingCheck: async () => {
              // Cross-pull Phase 2: a pack was already grabbed for this
              // season in a previous pull — the episode is now redundant.
              if (
                await this.hasRecentSeasonPackGrab(
                  seriesMatch.id,
                  parsed.season!,
                )
              )
                return true;
              const epDup = await this.historyRepo
                .createQueryBuilder('h')
                .where('h.mediaId = :mediaId', { mediaId: seriesMatch.id })
                .andWhere('h.status = :status', { status: 'grabbed' })
                .andWhere('h.sourceTitle ILIKE :pattern', {
                  pattern: `%${epLabel}%`,
                })
                .getOne();
              return !!epDup;
            },
          });
        }
      } catch (e) {
        this.log.warn(
          `RssSync: indexer "${indexer.name}" failed: ${(e as Error).message}`,
        );
      }
    }

    this.eventsService.emit({
      type: 'task.progress',
      command: 'RssSync',
      current: indexers.length,
      total: indexers.length,
      message: 'RssSync',
    });
  }

  /** Token match via {@link resolveSearchTitles} + year guard for movies.
   *  Short common titles ("Up", "It", "Heat", "Cars") otherwise match
   *  dozens of unrelated releases. Series skip the year guard — air-year
   *  mismatch is common across multi-season shows; the caller already
   *  requires a recognisable season in the release title. */
  private matchReleaseToMedia(
    release: ReleaseCandidate,
    candidates: Media[],
    yearGuard: boolean,
  ): Media | undefined {
    return candidates.find((m) =>
      releaseMatchesMedia(release.title, m, {
        requireYearInTitle: yearGuard,
      }),
    );
  }

  private matchMovieRelease(
    release: ReleaseCandidate,
    candidates: Media[],
  ): Media | undefined {
    return this.matchReleaseToMedia(release, candidates, true);
  }

  private matchSeriesRelease(
    release: ReleaseCandidate,
    candidates: Media[],
  ): Media | undefined {
    return this.matchReleaseToMedia(release, candidates, false);
  }

  private releaseTooFresh(
    release: ReleaseCandidate,
    media: Media,
    delayProfiles: DelayProfile[],
  ): boolean {
    return (
      !!release.publishDate &&
      this.isDelayed(media, release.publishDate, delayProfiles)
    );
  }

  /** RSS auto-grab wrapper — fills in fields shared by every release in
   *  the feed loop (source-title dedup) and forwards the rest to
   *  {@link AutoGrabExecutorService.tryAutoGrab}. */
  private async grabRssRelease(args: {
    media: Media;
    files: { quality?: string | null }[];
    release: ReleaseCandidate;
    qbitClient: DownloadClient;
    scoring: AutoGrabScoringContext;
    mediaType: 'movie' | 'series';
    label: string;
    runtimeMinutes: number;
    /** Season targeted by the matched release — forwarded so the
     *  request-lifecycle hook flips only the matching per-season
     *  requests when the grab succeeds. */
    seasonNumber?: number;
    /** Extra grab-dedup logic on top of the same-source-title check. */
    extraPendingCheck?: () => Promise<boolean>;
  }): Promise<boolean> {
    return this.autoGrabExec.tryAutoGrab({
      media: args.media,
      files: args.files,
      releases: [args.release],
      qbitClient: args.qbitClient,
      scoring: args.scoring,
      mediaType: args.mediaType,
      label: args.label,
      runtimeMinutes: args.runtimeMinutes,
      seasonNumber: args.seasonNumber,
      pendingCheck: async () => {
        // Same release in history — happens because the same item
        // re-appears across feed polls.
        const dup = await this.historyRepo.findOne({
          where: {
            media: { id: args.media.id },
            sourceTitle: args.release.title,
          },
        });
        if (dup) return true;
        return args.extraPendingCheck ? args.extraPendingCheck() : false;
      },
    });
  }

  /**
   * RSS Phase-2 helper: true when a season-pack release for
   * `(mediaId, seasonNumber)` was already grabbed within the last 24h.
   * Parses each recent history row's `sourceTitle` so we don't need a
   * dedicated `pending_release` table — the source-title itself is the
   * source of truth for what was grabbed.
   */
  private async hasRecentSeasonPackGrab(
    mediaId: number,
    seasonNumber: number,
  ): Promise<boolean> {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const recent = await this.historyRepo
      .createQueryBuilder('h')
      .where('h.mediaId = :mediaId', { mediaId })
      .andWhere('h.status = :status', { status: 'grabbed' })
      .andWhere('h.createdAt >= :since', { since })
      .getMany();
    return recent.some((r) => {
      const p = parseSeasonEpisode(r.sourceTitle ?? '');
      return p.isFullSeason && p.season === seasonNumber;
    });
  }

  private isDelayed(
    _media: Media,
    publishDate: string,
    delayProfiles: DelayProfile[],
  ): boolean {
    if (!delayProfiles.length) return false;
    // Pick the first profile (lowest order) and apply its delay to all media.
    const profile = delayProfiles[0];
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
        // Home-media dates first, then fall back to the cinema date plus a
        // grace window, the primary release date, and finally the catalogue
        // status — so titles whose digital/physical dates are absent from the
        // metadata source (typical for older catalogue films) still resolve.
        if (media.digitalRelease && media.digitalRelease <= today) return true;
        if (media.physicalRelease && media.physicalRelease <= today)
          return true;
        if (media.inCinemas && this.addDaysIso(media.inCinemas, 90) <= today)
          return true;
        if (media.releaseDate && media.releaseDate <= today) return true;
        return media.status === MediaStatus.RELEASED;
      default:
        return true;
    }
  }

  private addDaysIso(isoDate: string, days: number): string {
    const d = new Date(isoDate);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
}
