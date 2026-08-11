import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, Repository } from 'typeorm';
import * as path from 'path';
import { Media } from '../../modules/media/entities/media.entity';
import { DownloadHistory } from './entities/download-history.entity';
import { Season } from '../../modules/media/entities/season.entity';
import { Episode } from '../../modules/media/entities/episode.entity';
import { DownloadClient } from './download-clients/entities/download-client.entity';
import {
  QbittorrentService,
  QbittorrentTorrent,
  qbittorrentStateToProgress,
} from './download-clients/qbittorrent.service';
import { Indexer } from './indexers/entities/indexer.entity';
import { NamingService } from '../../modules/scheduler/naming.service';
import { BlocklistService } from './blocklist/blocklist.service';
import { EventsService } from '../../modules/scheduler/events.service';
import { AcquisitionEventsService } from './acquisition-events.service';
import { SettingsService } from '../../modules/settings/settings.service';
import {
  ThumbnailService,
  buildSpriteLabel,
} from '../../modules/streaming/thumbnail.service';
import { MediaType } from '../../common/enums';
import { StalledCheck } from './entities/stalled-check.entity';
import {
  countStalledStrikes,
  STALL_ELIGIBLE_STATES,
} from './stalled-progress.util';
import { getStallConfig, StallConfig } from './stall-config.util';
import { Library } from '../../modules/libraries/entities/library.entity';
import {
  TorrentHistoryMatcher,
  normaliseTorrentName,
  outranksForTorrent,
} from './torrent-history-matcher.service';
import { TorrentAutoMatcher } from './torrent-auto-matcher.service';
import { buildGrabHistoryRow } from './grab-history.util';
import { parseReleaseQuality } from '../../common/release-parsing';
import { MarkersService } from '../../modules/markers/markers.service';
import { LibraryIngestService } from '../../common/library-ingest/library-ingest.service';
import { VIDEO_EXTS } from '../../common/constants/video-extensions';

/**
 * How long a `grabbed` or `importing` history row may stay without a
 * matching qBit torrent before we mark it `failed`. The sweep only runs once
 * every client has answered (a partial fetch is skipped upstream), so a
 * torrent's absence is reliable; 5 min then absorbs the short-lived
 * mismatches that remain — a freshly-grabbed row whose torrent hasn't
 * surfaced yet, an HTML-entity decode drift between qBit and the indexer's
 * raw title, a rename mid-tick. The row is NEVER deleted; only its status
 * flips so the user sees the failure in Activities and can re-grab.
 */
const ORPHAN_GRACE_MS = 5 * 60_000;

/**
 * Status message stamped on a row the orphan sweep flips to `failed`. Kept as
 * a constant so the sweep can also recognise its own stamp and clear it when
 * the torrent reappears, rather than leaving a row reading "no longer present"
 * next to a torrent the client is still reporting.
 */
const ORPHAN_STATUS_MESSAGE = 'Torrent no longer present in download client';

@Injectable()
export class CompletionService implements OnModuleInit {
  private readonly log = new Logger(CompletionService.name);

  /** Torrent hashes the auto-matcher could not resolve on the previous tick.
   *  Rebuilt wholesale each run, so it stays bounded by the client's current
   *  torrent count and drops a hash as soon as the torrent leaves the client. */
  private unidentifiedHashes = new Set<string>();

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(DownloadHistory)
    private readonly historyRepo: Repository<DownloadHistory>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(DownloadClient)
    private readonly clientRepo: Repository<DownloadClient>,
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
    @InjectRepository(StalledCheck)
    private readonly stalledCheckRepo: Repository<StalledCheck>,
    @InjectRepository(Library)
    private readonly libraryRepo: Repository<Library>,
    private readonly qbittorrent: QbittorrentService,
    private readonly naming: NamingService,
    private readonly blocklist: BlocklistService,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
    private readonly thumbnailService: ThumbnailService,
    private readonly historyMatcher: TorrentHistoryMatcher,
    private readonly autoMatcher: TorrentAutoMatcher,
    private readonly markers: MarkersService,
    private readonly acquisitionEvents: AcquisitionEventsService,
    private readonly libraryIngest: LibraryIngestService,
  ) {}

  /**
   * `importing` is written before the copy starts, so a process that dies
   * mid-import leaves the row claiming an import that no longer exists — and
   * the import loop skips `importing` rows to avoid re-entering a copy still in
   * flight. Nothing is in flight right after boot, so re-arm them all.
   */
  async onModuleInit(): Promise<void> {
    const stranded = await this.historyRepo.update(
      { status: 'importing' },
      { status: 'grabbed' },
    );
    if (stranded.affected) {
      this.log.warn(
        `Import: re-armed ${stranded.affected} row(s) left importing by a previous run`,
      );
    }
  }

  /**
   * Whether series imports trigger automatic intro / outro marker
   * detection. Default on — most users want skip-intro working right
   * after a series finishes downloading.
   *
   * Admin-toggleable from the General settings page; defaults to `true`
   * (an unset key reads as enabled) to preserve behaviour on existing installs.
   */
  private async autoDetectMarkersOnImport(): Promise<boolean> {
    return (
      (await this.settings.get('markers_auto_detect_on_import')) !== 'false'
    );
  }

  /**
   * For every torrent currently in qBit that has no corresponding
   * `DownloadHistory` row (matched neither by hash nor by sourceTitle
   * fallback), attempt to identify its media via
   * {@link TorrentAutoMatcher} and create a fresh history row.
   *
   * Mutates `grabbed` in place to include any newly-created rows so
   * the caller's downstream loops treat them like normal grab rows.
   *
   * Skips torrents whose hash is already referenced by ANY history row
   * (including `completed` / `imported`) to avoid duplicating rows for
   * torrents we've already processed.
   */
  private async autoMatchOrphanTorrents(
    allTorrents: ReadonlyArray<
      QbittorrentTorrent & { _clientId: number; _client: DownloadClient }
    >,
  ): Promise<void> {
    if (!allTorrents.length) return;

    // Index every history row by its hash so we can tell apart:
    //  - "no row at all"            → create one.
    //  - "row exists, media linked" → already handled by the main matcher.
    //  - "row exists, media NULL"   → rebind the existing row (anomalous
    //    state from past bugs; we cannot SQL-diagnose so we heal at
    //    runtime). Updating instead of inserting keeps the row's
    //    original \`createdAt\` / status history.
    const allHistory = await this.historyRepo.find({
      relations: ['media'],
    });
    const rowByHash = new Map<string, DownloadHistory>();
    for (const h of allHistory) {
      if (!h.torrentHash) continue;
      const key = h.torrentHash.toLowerCase();
      const kept = rowByHash.get(key);
      if (!kept || outranksForTorrent(h, kept)) rowByHash.set(key, h);
    }

    const linkedTitles = new Set(
      allHistory
        .filter((h) => h.mediaId && h.sourceTitle)
        .map((h) => normaliseTorrentName(h.sourceTitle)),
    );

    const candidates = allTorrents.filter((t) => {
      if (!t.hash) return false;
      const existing = rowByHash.get(t.hash.toLowerCase());
      if (!existing) return true; // No row → candidate (create).
      if (!existing.mediaId) return true; // Row but unlinked → candidate (rebind).
      return false; // Row already linked → skip.
    });
    if (!candidates.length) {
      this.log.debug?.(
        `Auto-match: ${allTorrents.length} qBit torrents, all already linked — nothing to do`,
      );
      this.unidentifiedHashes = new Set();
      return;
    }
    this.log.debug?.(
      `Auto-match: scanning ${candidates.length}/${allTorrents.length} torrent(s) without a media link`,
    );

    let bound = 0;
    let rebound = 0;
    let skippedByNameFallback = 0;
    let unidentified = 0;
    const stillUnidentified = new Set<string>();
    for (const torrent of candidates) {
      const existingRow = rowByHash.get(torrent.hash!.toLowerCase());

      if (linkedTitles.has(normaliseTorrentName(torrent.name))) {
        skippedByNameFallback++;
        continue;
      }

      let match;
      try {
        match = await this.autoMatcher.tryMatch(torrent.name);
      } catch (err) {
        this.log.warn(
          `Auto-match: tryMatch threw on "${torrent.name}": ${(err as Error).message}`,
        );
        continue;
      }
      if (!match) {
        unidentified++;
        const hash = torrent.hash!.toLowerCase();
        stillUnidentified.add(hash);
        const message = `Auto-match: "${torrent.name}" — no media in library matches the parsed title (ambiguous or unknown)`;
        if (this.unidentifiedHashes.has(hash)) this.log.debug?.(message);
        else this.log.log(message);
        continue;
      }

      const quality = parseReleaseQuality(torrent.name).quality.name;
      const seasonId = match.season?.id ?? match.episode?.season?.id ?? null;
      const episodeId = match.episode?.id ?? null;

      let row: DownloadHistory;
      if (existingRow) {
        // Heal the existing orphan: assign the media + episode/season,
        // bump quality + sourceTitle (decoded) so the next tick's
        // matcher sees a clean row. Status / createdAt / grabSource
        // are left intact — this is restoration, not a new grab.
        existingRow.media = match.media;
        existingRow.episode = match.episode ?? null;
        existingRow.season = match.season ?? match.episode?.season ?? null;
        existingRow.quality = quality;
        row = await this.historyRepo.save(existingRow);
        rebound++;
      } else {
        row = await this.historyRepo.save(
          this.historyRepo.create(
            buildGrabHistoryRow({
              media: match.media,
              downloadClient: torrent._client,
              sourceTitle: torrent.name,
              torrentHash: torrent.hash,
              quality,
              // Auto-matched orphans look closer to a manual add (the
              // user put the torrent in qBit, we just figured out which
              // media it belongs to) than to a scheduler auto-grab.
              grabSource: 'manual',
              episodeId,
              seasonId,
            }),
          ),
        );
        bound++;
      }

      const epLabel = match.episode
        ? ` ${match.season ? `S${String(match.season.seasonNumber).padStart(2, '0')}` : ''}E${String(match.episode.episodeNumber).padStart(2, '0')}`
        : match.season
          ? ` Season ${match.season.seasonNumber}`
          : '';
      const verb = existingRow ? 'rebound' : 'bound';
      this.log.log(
        `Auto-match: ${verb} torrent "${torrent.name}" → ${match.media.title}${epLabel} (history #${row.id})`,
      );
    }
    this.unidentifiedHashes = stillUnidentified;
    const summary = `Auto-match: done — ${bound} created, ${rebound} healed, ${skippedByNameFallback} matched by name (will heal hash), ${unidentified} unidentified`;
    if (bound || rebound) this.log.log(summary);
    else this.log.debug?.(summary);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processCompleted(): Promise<void> {
    // Source of truth = qBittorrent. We iterate over the torrents qBit
    // reports, resolve each to its single canonical `DownloadHistory`
    // row, then import the completed ones. The previous flow was
    // history-centric (iterate every grabbed row, look for a matching
    // torrent) which O(n)-loops over every legacy duplicate every
    // minute. After migration 1779500000000 collapsed the legacy
    // duplicates the matcher returns exactly one row per torrent and
    // the loop is bounded by the qBit-torrent count.
    const clients = await this.clientRepo.find({ where: { enabled: true } });
    const qbitClients = clients.filter((c) => this.qbittorrent.supports(c));
    if (!qbitClients.length) {
      this.log.warn('Import: no enabled qBittorrent client found');
      return;
    }

    const fetches = await Promise.all(
      qbitClients.map(async (c) => {
        const { ok, torrents } = await this.qbittorrent.getTorrentsResult(c);
        return {
          ok,
          torrents: torrents.map((t) => ({
            ...t,
            _clientId: c.id,
            _client: c,
          })),
        };
      }),
    );
    // A failed fetch yields an empty list indistinguishable from a client
    // that genuinely holds nothing. The orphan sweep declares a torrent gone
    // by its absence, so it runs only when every client answered — a single
    // unreachable client would otherwise orphan every in-flight grab.
    const allClientsResponded = fetches.every((f) => f.ok);
    const allTorrents = fetches.flatMap((f) => f.torrents);

    // Phase 1 — auto-match orphan torrents (creates history rows for
    // qBit torrents that have no DB linkage yet).
    await this.autoMatchOrphanTorrents(allTorrents);

    // Load active rows AFTER auto-match so freshly-created rows are
    // included. `failed` and `warning` rows stay candidates so a user
    // who fixes the underlying issue (renamed file, edited library
    // path…) just has to wait one tick.
    const grabbed = await this.historyRepo.find({
      where: [
        { status: 'grabbed' },
        { status: 'failed' },
        { status: 'warning' },
      ],
    });
    // Importing rows are reconciled too, but kept out of `grabbed`: that array
    // also feeds Phase 3's matchAndHeal, which must not treat an already-
    // importing row as a fresh grab to match a completed torrent against.
    const importing = await this.historyRepo.find({
      where: { status: 'importing' },
    });

    // Phase 2 — reconcile grabbed/importing rows against the live torrent
    // list: flip ones whose torrent has been gone past the grace period to
    // `failed`, and clear a prior orphan stamp off any row whose torrent
    // reappeared. Media link is preserved either way. Skipped on a partial
    // fetch.
    if (allClientsResponded) {
      await this.reconcileOrphanHistory(allTorrents, grabbed, importing);
    }

    // Push live progress for in-flight grabs to each media's request audience.
    await this.emitDownloadProgress(allTorrents);

    // Phase 3 — import the completed torrents.
    const completedTorrents = allTorrents.filter(
      (t) =>
        t.progress >= 1 ||
        t.state === 'seeding' ||
        t.state === 'stalledUP' ||
        t.state === 'stoppedUP',
    );
    if (!completedTorrents.length) return;

    const formats = await this.naming.getFormats();
    const movieFolderFormat = formats.movieFolder;
    const seriesFolderFormat = formats.seriesFolder;
    const libraries = await this.libraryRepo.find({ order: { path: 'ASC' } });

    let imported = 0;
    for (const torrent of completedTorrents) {
      const history = await this.historyMatcher.matchAndHeal(torrent, grabbed);
      if (!history) continue;
      // Already imported or in flight: leave alone.
      if (
        history.status !== 'grabbed' &&
        history.status !== 'failed' &&
        history.status !== 'warning'
      ) {
        continue;
      }

      this.log.log(
        `Import: torrent "${torrent.name}" → history #${history.id} (mediaId=${history.mediaId}, status=${history.status})`,
      );

      try {
        await this.historyRepo.update(history.id, { status: 'importing' });
        await this.processOne(
          history,
          torrent,
          movieFolderFormat,
          seriesFolderFormat,
          libraries,
        );
        imported++;
      } catch (e) {
        this.log.error(
          `Import: FAILED for "${history.sourceTitle}": ${(e as Error).message}`,
        );
        await this.historyRepo.update(history.id, {
          status: 'failed',
          statusMessage: (e as Error).message,
        });

        await this.acquisitionEvents.publish({
          type: 'acquisition.failed',
          mediaId: history.mediaId,
          title: history.sourceTitle,
          reason: (e as Error).message,
        });

        // Auto-blocklist the failed release so it won't be grabbed again
        try {
          await this.blocklist.createFromHistory(
            history,
            `Auto-blocklist: import failed — ${(e as Error).message}`,
          );
          this.log.log(`Import: auto-blocklisted "${history.sourceTitle}"`);
        } catch {
          // ignore blocklist errors
        }
      }
    }
    if (imported > 0) {
      this.log.log(
        `Import: processed ${imported}/${completedTorrents.length} completed torrent(s)`,
      );
    }
  }

  /**
   * Push a `download.progress` SSE for every in-flight torrent to that media's
   * request audience. Reuses the same hash-first matcher as the queue endpoint;
   * resolves the season/episode scope so a series renders per-season progress.
   * Recipient resolution is core's job — this only publishes the domain fact.
   */
  private async emitDownloadProgress(
    allTorrents: ReadonlyArray<QbittorrentTorrent>,
  ): Promise<void> {
    const downloading = allTorrents.filter((t) => t.progress < 1);
    if (!downloading.length) return;
    const rows = await this.historyRepo.find({
      where: [{ status: 'grabbed' }, { status: 'importing' }],
      relations: ['media', 'season', 'episode'],
    });
    if (!rows.length) return;

    for (const t of downloading) {
      const match = await this.historyMatcher.matchAndHeal(t, rows);
      if (!match?.media) continue;
      await this.acquisitionEvents.publish({
        type: 'acquisition.progress',
        mediaId: match.mediaId,
        mediaType: match.media.type as 'movie' | 'series',
        seasonNumber: match.season?.seasonNumber,
        episodeNumber: match.episode?.episodeNumber,
        hash: t.hash,
        progress: t.progress,
        dlspeed: t.dlspeed,
        eta: t.eta,
        state: qbittorrentStateToProgress(t.state),
      });
    }
  }

  /**
   * Reconcile grabbed/importing/failed rows against the live torrent list.
   * Caller must pass a complete list (every client responded), since every
   * direction keys off a torrent's presence:
   *
   *  - A `grabbed` or `importing` row whose torrent has been gone for at least
   *    {@link ORPHAN_GRACE_MS} flips to `failed` — this is what reconciles a
   *    torrent the user removed from the client by hand. The grace is measured
   *    off `updatedAt`, which every status / hash heal write bumps, so a row
   *    whose torrent just arrived has a fresh timestamp and won't be flipped.
   *  - A `failed` row carrying the {@link ORPHAN_STATUS_MESSAGE} stamp whose
   *    torrent is matched again returns to `grabbed`, so the activity queue
   *    never shows "no longer present" beside a torrent the client still
   *    reports. A torrent that failed for any other reason keeps its status.
   *  - An `importing` row whose torrent is no longer complete returns to
   *    `grabbed`: no import can be in flight for it.
   *
   * The media link is preserved in every direction. A `queue.updated` event is
   * emitted on any change so the sidebar badge refreshes live rather than
   * staying stale until the next navigation.
   */
  private async reconcileOrphanHistory(
    allTorrents: ReadonlyArray<QbittorrentTorrent>,
    grabbed: DownloadHistory[],
    importing: DownloadHistory[],
  ): Promise<void> {
    if (!grabbed.length && !importing.length) return;
    // Match torrents against both sets so a live torrent keeps either kind of
    // row off the orphan list.
    const candidates = [...grabbed, ...importing];
    const torrentByHistoryId = new Map<number, QbittorrentTorrent>();
    for (const t of allTorrents) {
      const m = this.historyMatcher.findMatch(t, candidates);
      if (m) torrentByHistoryId.set(m.history.id, t);
    }
    const matchedHistoryIds = new Set(torrentByHistoryId.keys());

    let changed = false;

    // An import only ever starts on a complete torrent, so an `importing` row
    // whose torrent is no longer complete cannot have one in flight: the
    // process died mid-copy, or the payload vanished and the client restarted
    // the download. Re-arm it — `importing` is otherwise a dead end, excluded
    // from the import candidates and only ever reclaimed by the orphan sweep.
    const restarted = importing.filter((h) => {
      const t = torrentByHistoryId.get(h.id);
      return t != null && t.progress < 1;
    });
    if (restarted.length) {
      await this.historyRepo.update(
        restarted.map((h) => h.id),
        { status: 'grabbed', statusMessage: null as unknown as string },
      );
      changed = true;
      this.log.warn(
        `Import: ${restarted.length} importing entries whose torrent is no longer complete — re-armed as grabbed`,
      );
    }

    const revived = grabbed.filter(
      (h) =>
        h.status === 'failed' &&
        h.statusMessage === ORPHAN_STATUS_MESSAGE &&
        matchedHistoryIds.has(h.id),
    );
    if (revived.length) {
      await this.historyRepo.update(
        revived.map((h) => h.id),
        { status: 'grabbed', statusMessage: null as unknown as string },
      );
      changed = true;
      this.log.log(
        `Import: ${revived.length} entries reappeared in qBittorrent — cleared the orphan stamp and re-armed for import`,
      );
    }

    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    const expired = candidates.filter(
      (h) =>
        (h.status === 'grabbed' || h.status === 'importing') &&
        !matchedHistoryIds.has(h.id) &&
        h.updatedAt.getTime() < cutoff,
    );
    if (expired.length) {
      await this.historyRepo.update(
        expired.map((h) => h.id),
        {
          status: 'failed',
          statusMessage: ORPHAN_STATUS_MESSAGE,
        },
      );
      changed = true;
      this.log.warn(
        `Import: ${expired.length} grabbed/importing entries lost their torrent in qBittorrent for > ${ORPHAN_GRACE_MS / 60_000}min — marked failed (media link preserved)`,
      );
    }

    if (changed) await this.acquisitionEvents.publish({ type: 'acquisition.queue.changed' });
  }

  private async processOne(
    history: DownloadHistory,
    torrent: QbittorrentTorrent & {
      _clientId?: number;
      _client?: DownloadClient;
    },
    movieFolderFormat: string,
    seriesFolderFormat: string,
    libraries: Library[],
  ): Promise<void> {
    // Use qBittorrent API to get actual files of this torrent
    const videoFiles: { filePath: string; size: number }[] = [];

    if (torrent._client) {
      const torrentFiles = await this.qbittorrent.getTorrentFiles(
        torrent._client,
        torrent.hash,
      );
      for (const f of torrentFiles) {
        const ext = path.extname(f.name).toLowerCase();
        if (VIDEO_EXTS.has(ext) && f.progress >= 1) {
          const filePath = path.join(torrent.save_path, f.name);
          videoFiles.push({ filePath, size: f.size });
        }
      }
      this.log.log(
        `Import[${history.sourceTitle}]: qBittorrent API returned ${torrentFiles.length} file(s), ${videoFiles.length} video(s)`,
      );
    }

    if (!videoFiles.length) {
      // The download completed but carries no playable video — archived
      // (RAR/ISO), sample-only, or a non-video payload. Treat it as a failed
      // import: blocklist the release so the next search skips it, then drop
      // the dud torrent and its files so it leaves the queue and stops
      // re-triggering this import each tick. SearchMissing grabs a working
      // release on its normal cadence.
      const statusMessage = `Import failed: no valid video file in the download "${torrent.name}"`;
      this.log.warn(`Import[${history.sourceTitle}]: ${statusMessage}`);
      await this.historyRepo.update(history.id, {
        status: 'failed',
        statusMessage,
      });

      try {
        await this.blocklist.createFromHistory(
          history,
          'Auto-blocklist: no valid video file in the download',
        );
        this.log.log(`Import[${history.sourceTitle}]: auto-blocklisted`);
      } catch {
        // Already blocklisted — carry on with removal.
      }
      if (torrent._client) {
        try {
          await this.qbittorrent.deleteTorrent(
            torrent._client,
            torrent.hash,
            true,
          );
        } catch (e) {
          this.log.warn(
            `Import[${history.sourceTitle}]: failed to remove dud torrent: ${(e as Error).message}`,
          );
        }
      }

      await this.acquisitionEvents.publish({
        type: 'acquisition.failed',
        mediaId: history.mediaId,
        title: history.sourceTitle,
        reason: statusMessage,
      });
      return;
    }

    this.log.log(
      `Import[${history.sourceTitle}]: found ${videoFiles.length} video file(s)`,
    );

    const media = await this.mediaRepo.findOne({
      where: { id: history.mediaId },
      relations: ['library'],
    });
    if (!media) {
      const statusMessage = `Import failed: media id=${history.mediaId} not found`;
      this.log.warn(`Import[${history.sourceTitle}]: ${statusMessage}`);
      await this.historyRepo.update(history.id, {
        status: 'failed',
        statusMessage,
      });
      await this.acquisitionEvents.publish({ type: 'acquisition.queue.changed' });
      return;
    }
    this.log.log(
      `Import[${history.sourceTitle}]: media="${media.title}" (${media.type}, id=${media.id})`,
    );

    // Destination root folder (just the root, without folderName — folderName
    // is appended separately when building destDir).
    let rootPath = media.library?.path ?? '';
    let resolvedLib = media.library ?? null;
    if (!rootPath) {
      const fallback = libraries.find((l) => !!l.path);
      if (!fallback) {
        const statusMessage = 'Import failed: no library path configured';
        this.log.warn(`Import[${history.sourceTitle}]: ${statusMessage}`);
        await this.historyRepo.update(history.id, {
          status: 'failed',
          statusMessage,
        });
        await this.acquisitionEvents.publish({ type: 'acquisition.queue.changed' });
        return;
      }
      resolvedLib = fallback;
      rootPath = fallback.path!;
      this.log.log(
        `Import[${history.sourceTitle}]: no path on media, falling back to library "${fallback.name}" (${rootPath})`,
      );
    }

    // Ensure folderName is set
    const folderName =
      media.folderName ||
      (media.type === MediaType.MOVIE
        ? this.naming.applyMovieFolderFormat(movieFolderFormat, {
            title: media.title,
            originalTitle: media.originalTitle,
            year: media.year,
            tmdbId: media.tmdbId,
          })
        : this.naming.applySeriesFolderFormat(seriesFolderFormat, {
            seriesTitle: media.title,
            originalTitle: media.originalTitle,
            year: media.year,
            tmdbId: media.tmdbId,
          }));
    if (!media.folderName) {
      await this.mediaRepo.update(media.id, { folderName });
    }

    // Pin the library on media without one.
    if (!media.libraryId && resolvedLib) {
      await this.mediaRepo.update(media.id, {
        library: { id: resolvedLib.id } as Library,
      });
      this.log.log(
        `Import[${history.sourceTitle}]: pinned libraryId=${resolvedLib.id} on media`,
      );
    }

    // Keep the in-memory media in sync with what was just persisted — the
    // ingest service re-reads media.path (library.path + folderName) to
    // derive the destination.
    media.folderName = folderName;
    if (resolvedLib) media.library = resolvedLib;

    const result = await this.libraryIngest.ingest({
      mediaId: media.id,
      files: videoFiles.map((f) => ({ path: f.filePath, size: f.size })),
      transfer: 'copy',
      fallbackQuality: history.quality,
      releaseName: history.sourceTitle,
      sourceLabel: history.sourceTitle,
      force: true,
    });
    const importedFiles = result.imported.map(({ file, episodeId, seasonId }) => ({
      savedFile: file,
      episodeId,
      seasonId,
    }));

    if (!importedFiles.length) {
      const statusMessage = `Import failed: no file could be placed under the library root for "${torrent.name}"`;
      this.log.error(`Import[${history.sourceTitle}]: ${statusMessage}`);
      await this.historyRepo.update(history.id, {
        status: 'failed',
        statusMessage,
      });
      await this.acquisitionEvents.publish({ type: 'acquisition.queue.changed' });
      return;
    }

    // Reconcile the history row with what was actually imported. Its
    // episode/season were set at grab time to the episode we *searched
    // for*; a loose indexer match can land a different episode's release,
    // leaving Activities showing the wrong episode. Re-point from the
    // imported files: a single episode pins both; a season pack pins the
    // season and clears the episode. This also self-heals legacy mislinked
    // rows on re-import.
    const completedPatch: {
      status: 'completed';
      episode?: Episode | null;
      season?: Season | null;
    } = { status: 'completed' };
    if (media.type === MediaType.SERIES) {
      const epIds = [
        ...new Set(
          importedFiles
            .map((f) => f.episodeId)
            .filter((id): id is number => id != null),
        ),
      ];
      const seasonIds = [
        ...new Set(
          importedFiles
            .map((f) => f.seasonId)
            .filter((id): id is number => id != null),
        ),
      ];
      if (epIds.length === 1 && seasonIds.length === 1) {
        completedPatch.episode = { id: epIds[0] } as Episode;
        completedPatch.season = { id: seasonIds[0] } as Season;
      } else if (seasonIds.length === 1) {
        completedPatch.episode = null;
        completedPatch.season = { id: seasonIds[0] } as Season;
      }
    }
    await this.historyRepo.update(history.id, completedPatch);
    this.log.log(
      `Import[${history.sourceTitle}]: completed successfully (${importedFiles.length} file(s))`,
    );

    // Single-season series imports carry the season so the client retires only
    // that season's live progress (other in-flight seasons keep advancing).
    let importedSeasonNumber: number | undefined;
    const importedSeasonId = completedPatch.season?.id;
    if (importedSeasonId != null) {
      const s = await this.seasonRepo.findOne({
        where: { id: importedSeasonId },
        select: ['id', 'seasonNumber'],
      });
      importedSeasonNumber = s?.seasonNumber;
    }
    // Single-episode imports also carry the episode so the client retires only
    // that episode's progress leaf, leaving sibling episodes of the same season
    // still downloading (a whole-season clear would wipe them for ~60s).
    let importedEpisodeNumber: number | undefined;
    const importedEpisodeId = completedPatch.episode?.id;
    if (importedEpisodeId != null) {
      const e = await this.episodeRepo.findOne({
        where: { id: importedEpisodeId },
        select: ['id', 'episodeNumber'],
      });
      importedEpisodeNumber = e?.episodeNumber;
    }
    await this.acquisitionEvents.publish({
      type: 'acquisition.imported',
      mediaId: media.id,
      title: media.title,
      seasonNumber: importedSeasonNumber,
      episodeNumber: importedEpisodeNumber,
      quality: history.quality,
      sourceTitle: history.sourceTitle,
      mediaPath: media.path,
    });

    // Series only: kick off intro / outro marker detection for every
    // season whose episodes just landed. Detection runs at season
    // granularity (it compares audio fingerprints across episodes) so
    // we dedupe per season. Fire-and-forget; the detection itself is
    // queued via a Command row, and the in-flight guard skips seasons
    // already being scanned.
    if (media.type === 'series') {
      void (async () => {
        if (!(await this.autoDetectMarkersOnImport())) return;
        const seasonIds = new Set<number>();
        for (const { episodeId: epId } of importedFiles) {
          if (epId == null) continue;
          const ep = await this.episodeRepo.findOne({
            where: { id: epId },
            relations: ['season'],
          });
          if (ep?.season?.id) seasonIds.add(ep.season.id);
        }
        for (const seasonId of seasonIds) {
          try {
            await this.markers.detectSeason(seasonId, 'auto');
          } catch (e) {
            // BadRequest (already in flight) and infra errors stay
            // out of the import path — detection is best effort.
            this.log.debug?.(
              `Post-import marker detection skipped season #${seasonId}: ${(e as Error).message}`,
            );
          }
        }
      })();
    }

    // Generate thumbnail sprites (seekbar preview) for each imported file.
    // Runs in background — generateForFile is idempotent and ThumbnailService
    // queues internally to cap concurrency.
    void (async () => {
      for (const { savedFile, episodeId: epId } of importedFiles) {
        let episode: {
          seasonNumber?: number | null;
          episodeNumber?: number | null;
          title?: string | null;
        } | null = null;
        if (epId != null) {
          const ep = await this.episodeRepo.findOne({
            where: { id: epId },
            relations: ['season'],
          });
          if (ep) {
            episode = {
              seasonNumber: ep.season?.seasonNumber,
              episodeNumber: ep.episodeNumber,
              title: ep.title,
            };
          }
        }
        const label = buildSpriteLabel(media, episode);
        try {
          await this.thumbnailService.generateForFile(savedFile, media, label);
        } catch (e) {
          this.log.warn(
            `Post-import sprite generation failed for file #${savedFile.id}: ${e}`,
          );
        }
      }
    })();

    // Execute post-import script if configured
    try {
      const scriptRows: { value: string | null }[] =
        await this.dataSource.query(
          `SELECT value FROM app_settings WHERE key = 'post_import_script' LIMIT 1`,
        );
      const scriptSetting = scriptRows[0];
      const script = scriptSetting?.value?.trim();
      if (script) {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const env = {
          ...process.env,
          FLIKS_MEDIA_TITLE: media.title,
          FLIKS_MEDIA_ID: String(media.id),
          FLIKS_MEDIA_TYPE: media.type,
          FLIKS_QUALITY: history.quality,
          FLIKS_FILE_COUNT: String(importedFiles.length),
          FLIKS_SOURCE_TITLE: history.sourceTitle,
        };
        const { stdout, stderr } = await execAsync(script, {
          env,
          timeout: 30_000,
        });
        if (stdout.trim())
          this.log.log(`Post-import script stdout: ${stdout.trim()}`);
        if (stderr.trim())
          this.log.warn(`Post-import script stderr: ${stderr.trim()}`);
      }
    } catch (e) {
      this.log.warn(`Post-import script failed: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Stalled torrent cleanup
  // ---------------------------------------------------------------------------

  /**
   * Global stalled-download cleanup, gated by {@link getStallConfig}. For
   * every active downloading torrent, we snapshot the `downloaded` byte
   * counter at the configured interval. When the last N snapshots show no
   * meaningful progress, the download is considered stalled and is removed
   * + blocklisted.
   *
   * Whether a new search is triggered depends on:
   *   - the `autoRestart` setting,
   *   - the grab source (`auto`|`manual`), and
   *   - the `includeManualGrabs` setting.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async cleanStalledTorrents(): Promise<void> {
    // Housekeeping first — discard ancient snapshots regardless of anything else.
    await this.pruneOldStalledChecks();

    const stallConfig = await getStallConfig(this.settings);
    if (!stallConfig) return;

    const clients = await this.clientRepo.find({ where: { enabled: true } });
    const qbitClients = clients.filter((c) => this.qbittorrent.supports(c));
    if (!qbitClients.length) return;

    // Candidate histories for the torrent↔history match, loaded once for all
    // clients. `completed` rows are excluded — a finished import is no longer
    // an in-flight download. The matcher falls back to name matching and
    // self-heals missing hashes, so grabs whose hash was never recovered at
    // add time are still covered (the old hash-only lookup skipped them).
    const histories = await this.historyRepo.find({
      where: [
        { status: 'grabbed' },
        { status: 'failed' },
        { status: 'warning' },
        { status: 'importing' },
      ],
      relations: ['media'],
    });

    const mediaToResearch = new Set<number>();
    const now = Date.now();

    for (const client of qbitClients) {
      let torrents: QbittorrentTorrent[];
      try {
        torrents = await this.qbittorrent.getTorrents(client);
      } catch {
        continue;
      }

      const downloading = torrents.filter(
        (t) =>
          t.progress < 1 &&
          t.hash &&
          t.hash.length > 0 &&
          STALL_ELIGIBLE_STATES.has(t.state),
      );
      if (!downloading.length) continue;

      for (const t of downloading) {
        const history = await this.historyMatcher.matchAndHeal(t, histories);
        if (!history) continue; // Untracked torrent — not our business.

        const stalled = await this.evaluateStalled(t, stallConfig, now);
        if (!stalled) continue;

        this.log.warn(
          `StalledCleanup: "${t.name}" stalled (samples=${stallConfig.samples}, interval=${stallConfig.intervalMinutes}m)`,
        );

        // Remove torrent from qBittorrent (files too). If deletion fails we
        // intentionally skip everything else so we don't double-blocklist or
        // mark a history entry failed for a torrent still running in the client.
        try {
          await this.qbittorrent.deleteTorrent(client, t.hash, true);
        } catch (e) {
          this.log.error(
            `StalledCleanup: failed to delete "${t.name}": ${(e as Error).message}`,
          );
          continue;
        }

        await this.stalledCheckRepo.delete({ torrentHash: t.hash });

        await this.acquisitionEvents.publish({
          type: 'acquisition.stalled.removed',
          mediaId: history.mediaId ?? null,
          title: history.sourceTitle ?? t.name,
        });

        await this.blocklist.createFromHistory(
          history,
          'Auto-blocklist: stalled torrent',
        );

        history.status = 'failed';
        history.statusMessage = 'Stalled — removed by stalled-download cleanup';
        await this.historyRepo.save(history);

        const shouldRestart =
          stallConfig.autoRestart &&
          (history.grabSource === 'auto' || stallConfig.includeManualGrabs);
        if (shouldRestart && history.mediaId) {
          mediaToResearch.add(history.mediaId);
          this.log.log(
            `StalledCleanup: "${history.sourceTitle ?? t.name}" blocklisted — searching for a replacement for media #${history.mediaId}`,
          );
        } else if (!shouldRestart) {
          this.log.log(
            `StalledCleanup: "${history.sourceTitle ?? t.name}" blocklisted — no auto-restart (autoRestart=${stallConfig.autoRestart}, grabSource=${history.grabSource})`,
          );
        }
      }
    }

    if (mediaToResearch.size > 0) {
      this.log.log(
        `StalledCleanup: running SearchMissing for ${mediaToResearch.size} media(s)`,
      );
      this.events.emitDomain({
        type: 'media.acquisition.requested',
        mediaIds: Array.from(mediaToResearch),
        reason: 'stalled-cleanup',
      });
    }
  }

  /**
   * Records a snapshot if the interval has elapsed, then checks whether the
   * last `samples` snapshots form an unbroken no-progress run (each step
   * within the tolerance of `stalled-progress.util`).
   */
  private async evaluateStalled(
    torrent: QbittorrentTorrent,
    config: Pick<StallConfig, 'samples' | 'intervalMinutes'>,
    now: number,
  ): Promise<boolean> {
    const hash = torrent.hash;
    const currentBytes = BigInt(torrent.downloaded ?? 0).toString();

    const latest = await this.stalledCheckRepo.findOne({
      where: { torrentHash: hash },
      order: { checkedAt: 'DESC' },
    });

    const intervalMs = config.intervalMinutes * 60_000;
    const shouldSnapshot =
      !latest || now - latest.checkedAt.getTime() >= intervalMs;

    if (shouldSnapshot) {
      await this.stalledCheckRepo.save(
        this.stalledCheckRepo.create({
          torrentHash: hash,
          downloadedBytes: currentBytes,
        }),
      );
    }

    const recent = await this.stalledCheckRepo.find({
      where: { torrentHash: hash },
      order: { checkedAt: 'DESC' },
      take: config.samples,
    });

    if (recent.length < config.samples) return false;
    // `recent` is DESC by checkedAt — exactly the order the strike counter
    // expects. Tolerant comparison: a stalled torrent keeps receiving a
    // trickle of wasted bytes from churning peers, so strict byte equality
    // would never fire.
    return countStalledStrikes(recent) >= config.samples;
  }

  /**
   * Deletes stalled-check rows older than 24 h to keep the table small.
   * Assumes every profile's detection window (`(samples - 1) × interval`)
   * stays under 24 h — a longer custom window would lose its oldest
   * snapshots before the run could complete.
   */
  private async pruneOldStalledChecks(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    await this.stalledCheckRepo.delete({ checkedAt: LessThan(cutoff) });
  }

  // ---------------------------------------------------------------------------
  // Seed ratio cleanup — remove torrents that have met their seed ratio target
  // ---------------------------------------------------------------------------

  @Cron(CronExpression.EVERY_5_MINUTES)
  async cleanSeededTorrents(): Promise<void> {
    // Fetch torrents from all enabled qBittorrent clients
    const clients = await this.clientRepo.find({ where: { enabled: true } });
    const qbitClients = clients.filter((c) => this.qbittorrent.supports(c));
    if (!qbitClients.length) return;

    const allTorrents: {
      client: (typeof clients)[0];
      torrent: QbittorrentTorrent;
    }[] = [];
    for (const client of qbitClients) {
      try {
        const torrents = await this.qbittorrent.getTorrents(client);
        for (const t of torrents) allTorrents.push({ client, torrent: t });
      } catch {
        continue;
      }
    }
    if (!allTorrents.length) return;

    const torrentMap = new Map(
      allTorrents.map((e) => [e.torrent.hash.toLowerCase(), e]),
    );

    // Scoped to the hashes the client still holds: history grows forever while
    // the client's contents don't, and a row whose torrent is already gone has
    // nothing left to clean up.
    const withHash = await this.historyRepo
      .createQueryBuilder('h')
      .where('h.status = :status', { status: 'completed' })
      .andWhere('LOWER(h."torrentHash") IN (:...hashes)', {
        hashes: [...torrentMap.keys()],
      })
      .getMany();
    if (!withHash.length) return;

    const indexers = await this.indexerRepo.find();
    const indexerMap = new Map(indexers.map((ix) => [ix.id, ix]));

    const nowSec = Math.floor(Date.now() / 1000);
    let deleted = 0;

    for (const history of withHash) {
      const entry = torrentMap.get(history.torrentHash.toLowerCase());
      if (!entry) continue; // torrent already removed

      const { client, torrent } = entry;
      const indexer = history.indexerId
        ? indexerMap.get(history.indexerId)
        : undefined;
      const settings = indexer?.settings ?? {};
      const targetRatio = Number(settings['seedRatio'] ?? 1);
      const maxRetentionDays =
        settings['maxRetentionDays'] != null
          ? Number(settings['maxRetentionDays'])
          : null;

      let reason = '';
      if (
        maxRetentionDays != null &&
        maxRetentionDays > 0 &&
        torrent.completion_on > 0
      ) {
        const ageDays = (nowSec - torrent.completion_on) / 86400;
        if (ageDays >= maxRetentionDays) {
          reason = `retention ${Math.round(ageDays)}d >= ${maxRetentionDays}d`;
        }
      }
      if (!reason && torrent.ratio >= targetRatio) {
        reason = `ratio ${torrent.ratio.toFixed(2)} >= ${targetRatio}`;
      }

      if (!reason) continue;

      this.log.log(`SeedCleanup: removing "${torrent.name}" (${reason})`);
      try {
        await this.qbittorrent.deleteTorrent(client, torrent.hash, true);
        deleted++;
      } catch (e) {
        this.log.error(
          `SeedCleanup: failed to delete "${torrent.name}": ${(e as Error).message}`,
        );
      }
    }

    if (deleted > 0) {
      await this.acquisitionEvents.publish({ type: 'acquisition.queue.changed' });
    }
  }
}
