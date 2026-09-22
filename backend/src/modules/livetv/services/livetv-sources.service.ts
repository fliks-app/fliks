import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { LiveTvSource } from '../entities/livetv-source.entity';
import { LiveTvChannel } from '../entities/livetv-channel.entity';
import { LiveTvChannelStream } from '../entities/livetv-channel-stream.entity';
import { parseM3u, isOnDemandUrl, type M3uEntry } from '../parsing/m3u.parser';
import { normalizeChannelName } from '../parsing/channel-name';
import {
  XtreamClient,
  detectXtreamFromUrl,
  detectXtreamFromStreamUrl,
  xtreamPlaylistUrl,
  pickOutputFormat,
  type XtreamCredentials,
} from './xtream.client';
import { LiveTvLogoService } from './livetv-logo.service';
import { LiveTvAccessService } from './livetv-access.service';
import { SettingsService } from '../../settings/settings.service';
import {
  assertNotInternal,
  liveTvGet,
  liveTvIdentityOf,
  isNotModified,
  readValidators,
  type HttpCacheValidators,
  type LiveTvRequestIdentity,
} from '../livetv-http';
import {
  isHttpSource,
  readLocalPlaylist,
  removeStoredPlaylist,
} from './livetv-playlist-file';
import { CreateLiveTvSourceDto } from '../dto/create-livetv-source.dto';
import { UpdateLiveTvSourceDto } from '../dto/update-livetv-source.dto';
import { TestLiveTvSourceDto } from '../dto/test-livetv-source.dto';
import type { LiveTvSourceKind } from '../entities/livetv-source.entity';

/** A refresh returning less than this share of the known lineup is treated as a
 *  truncated or rate-limited response, not as the provider dropping channels. */
const SUSPICIOUS_SHRINK_RATIO = 0.5;
const SAVE_CHUNK = 500;
const MS_PER_DAY = 86_400_000;

export interface LiveTvSourceTestResult {
  ok: boolean;
  kind: 'm3u' | 'xtream';
  /** Entries that would actually become channels: on-demand and filtered-out
   *  groups are already excluded. */
  channelCount: number;
  onDemandCount: number;
  groups: { name: string; count: number }[];
  guideUrl: string | null;
  guideUrls: string[];
  /** A self-refreshing playlist link rebuilt from an uploaded file's entries. */
  playlistUrlFromFile?: string | null;
  maxConnections: number;
  expiresAt: Date | null;
  accountStatus: string | null;
  /** A pasted "m3u" URL that is really an Xtream panel link in disguise. */
  suggestion?: {
    suggestedKind: 'xtream';
    baseUrl: string;
    username: string;
    password: string;
  };
  error?: string;
}

export interface LiveTvSyncResult {
  ok: boolean;
  added: number;
  updated: number;
  removed: number;
  channelCount: number;
  error?: string;
}

/** One playlist entry, whichever provider protocol produced it. */
interface NormalizedEntry {
  externalId: string;
  name: string;
  url: string;
  logo: string | null;
  groupName: string | null;
  tvgId: string | null;
  number: number | null;
  qualityLabel: string | null;
  /** `tvg-shift`, in minutes: some guides are published against another timezone. */
  shiftMinutes: number;
  userAgent: string | null;
  referer: string | null;
}

interface ConnDescriptor {
  kind: LiveTvSourceKind;
  url: string;
  username?: string | null;
  password?: string | null;
  userAgent?: string | null;
  referer?: string | null;
}

interface FetchedLineup {
  notModified: false;
  entries: NormalizedEntry[];
  guideUrls: string[];
  maxConnections: number | null;
  expiresAt: Date | null;
  accountStatus: string | null;
  playlistEtag: string | null;
  playlistLastModified: string | null;
}

interface ClassifyResult {
  live: NormalizedEntry[];
  onDemandCount: number;
  groups: { name: string; count: number }[];
}

@Injectable()
export class LiveTvSourcesService {
  private readonly log = new Logger(LiveTvSourcesService.name);

  constructor(
    @InjectRepository(LiveTvSource)
    private readonly sourceRepo: Repository<LiveTvSource>,
    @InjectRepository(LiveTvChannel)
    private readonly channelRepo: Repository<LiveTvChannel>,
    @InjectRepository(LiveTvChannelStream)
    private readonly streamRepo: Repository<LiveTvChannelStream>,
    private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly logos: LiveTvLogoService,
    private readonly access: LiveTvAccessService,
  ) {}

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  findAll(): Promise<LiveTvSource[]> {
    return this.sourceRepo.find({ order: { priority: 'ASC', name: 'ASC' } });
  }

  /** `password` is `select: false` on the entity; a plain `findOne` leaves it
   *  undefined, so every real caller (sync, the xtream client) goes through
   *  here and gets it back explicitly. */
  async findOne(id: number): Promise<LiveTvSource> {
    const source = await this.sourceRepo
      .createQueryBuilder('source')
      .addSelect('source.password')
      .where('source.id = :id', { id })
      .getOne();
    if (!source) throw new NotFoundException(`Live TV source #${id} not found`);
    return source;
  }

  create(dto: CreateLiveTvSourceDto): Promise<LiveTvSource> {
    compileGroupPattern(dto.includeGroupsPattern, 'includeGroupsPattern');
    compileGroupPattern(dto.excludeGroupsPattern, 'excludeGroupsPattern');
    return this.sourceRepo.save(
      this.sourceRepo.create({ ...dto, maxStreamsIsManual: dto.maxStreams != null }),
    );
  }

  async update(id: number, dto: UpdateLiveTvSourceDto): Promise<LiveTvSource> {
    const source = await this.findOne(id);
    compileGroupPattern(dto.includeGroupsPattern ?? source.includeGroupsPattern, 'includeGroupsPattern');
    compileGroupPattern(dto.excludeGroupsPattern ?? source.excludeGroupsPattern, 'excludeGroupsPattern');
    // A field left out of a partial PATCH is `undefined`, not absent: TS class
    // fields ([[Define]] semantics) still declare it, so Object.assign would
    // stamp `undefined` onto the returned entity even though the row is untouched.
    if (dto.name !== undefined) source.name = dto.name;
    if (dto.kind !== undefined) source.kind = dto.kind;
    if (dto.url !== undefined) source.url = dto.url;
    if (dto.username !== undefined) source.username = dto.username;
    if (dto.password !== undefined) source.password = dto.password;
    if (dto.userAgent !== undefined) source.userAgent = dto.userAgent;
    if (dto.referer !== undefined) source.referer = dto.referer;
    if (dto.maxStreams !== undefined) {
      source.maxStreams = dto.maxStreams;
      source.maxStreamsIsManual = true;
    }
    if (dto.refreshIntervalHours !== undefined) source.refreshIntervalHours = dto.refreshIntervalHours;
    if (dto.enabled !== undefined) source.enabled = dto.enabled;
    if (dto.priority !== undefined) source.priority = dto.priority;
    if (dto.includeGroupsPattern !== undefined) source.includeGroupsPattern = dto.includeGroupsPattern;
    if (dto.excludeGroupsPattern !== undefined) source.excludeGroupsPattern = dto.excludeGroupsPattern;
    return this.sourceRepo.save(source);
  }

  async remove(id: number): Promise<void> {
    const source = await this.findOne(id);
    // Scoped to this source's own channels, and atomic with the source delete:
    // a crash between the two used to leave streamless channels in the lineup.
    await this.dataSource.transaction(async (manager) => {
      const channelRepo = manager.getRepository(LiveTvChannel);
      const streamRepo = manager.getRepository(LiveTvChannelStream);
      const sourceRepo = manager.getRepository(LiveTvSource);

      const candidateIds = (
        await streamRepo
          .createQueryBuilder('s')
          .select('DISTINCT s."channelId"', 'channelId')
          .where('s."sourceId" = :sourceId', { sourceId: source.id })
          .getRawMany<{ channelId: number }>()
      ).map((r) => r.channelId);

      await sourceRepo.remove(source);

      // The streams cascade with the source; a channel left with none would
      // otherwise linger in the lineup with nothing to play.
      if (candidateIds.length) {
        await channelRepo
          .createQueryBuilder()
          .delete()
          .whereInIds(candidateIds)
          .andWhere(
            'NOT EXISTS (SELECT 1 FROM livetv_channel_streams s WHERE s."channelId" = "livetv_channels"."id")',
          )
          .execute();
      }
    });

    // An uploaded playlist belongs to its source and goes with it.
    await removeStoredPlaylist(source.url).catch((err) =>
      this.log.warn(`Failed to remove stored playlist for source #${source.id}: ${errorMessage(err)}`),
    );
  }

  // ---------------------------------------------------------------------------
  // Test: probes without ever persisting
  // ---------------------------------------------------------------------------

  async test(dto: TestLiveTvSourceDto): Promise<LiveTvSourceTestResult> {
    const suggestion =
      dto.kind === 'm3u' ? (detectXtreamFromUrl(dto.url) ?? undefined) : undefined;
    let suggestionField = suggestion
      ? { suggestedKind: 'xtream' as const, ...suggestion }
      : undefined;

    try {
      // The probe's result returns straight to the caller: the real SSRF surface.
      await assertNotInternal(dto.url);
      const includePattern = compileGroupPattern(dto.includeGroupsPattern, 'includeGroupsPattern');
      const excludePattern = compileGroupPattern(dto.excludeGroupsPattern, 'excludeGroupsPattern');
      const fetched = await this.fetchLineup({
        kind: dto.kind,
        url: dto.url,
        username: dto.username,
        password: dto.password,
        userAgent: dto.userAgent,
        referer: dto.referer,
      });
      if (fetched.notModified) throw new Error('unexpected not-modified response');

      const { live, onDemandCount, groups } = classifyEntries(
        fetched.entries,
        includePattern,
        excludePattern,
      );
      // An uploaded file never refreshes itself. When its entries carry panel
      // credentials, the live link that does refresh can be rebuilt from them.
      if (!suggestionField && dto.kind === 'm3u' && !isHttpSource(dto.url)) {
        const fromEntry = live.length ? detectXtreamFromStreamUrl(live[0].url) : null;
        if (fromEntry) {
          suggestionField = { suggestedKind: 'xtream' as const, ...fromEntry };
        }
      }

      return {
        ok: true,
        kind: dto.kind,
        channelCount: live.length,
        onDemandCount,
        groups,
        playlistUrlFromFile: suggestionField ? xtreamPlaylistUrl(suggestionField) : null,
        guideUrl: fetched.guideUrls[0] ?? null,
        guideUrls: fetched.guideUrls,
        maxConnections: fetched.maxConnections ?? 0,
        expiresAt: fetched.expiresAt,
        accountStatus: fetched.accountStatus,
        suggestion: suggestionField,
      };
    } catch (err) {
      return {
        ok: false,
        kind: dto.kind,
        channelCount: 0,
        onDemandCount: 0,
        groups: [],
        guideUrl: null,
        guideUrls: [],
        maxConnections: 0,
        expiresAt: null,
        accountStatus: null,
        suggestion: suggestionField,
        error: errorMessage(err),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  async sync(sourceId: number): Promise<LiveTvSyncResult> {
    const source = await this.findOne(sourceId);

    let fetched: FetchedLineup | { notModified: true };
    try {
      fetched = await this.fetchLineup(connOf(source), {
        etag: source.playlistEtag,
        lastModified: source.playlistLastModified,
      });
    } catch (err) {
      const message = errorMessage(err);
      // The previous lineup is left untouched, only the status row changes.
      await this.sourceRepo.update(source.id, {
        lastSyncAt: new Date(),
        lastSyncStatus: 'error',
        lastSyncError: message,
      });
      this.log.warn(`Sync "${source.name}" failed: ${message}`);
      return {
        ok: false,
        added: 0,
        updated: 0,
        removed: 0,
        channelCount: source.channelCount,
        error: message,
      };
    }

    if (fetched.notModified) {
      await this.sourceRepo.update(source.id, {
        lastSyncAt: new Date(),
        lastSyncStatus: 'ok',
        lastSyncError: null,
      });
      this.log.log(`Sync "${source.name}": not modified, lineup unchanged`);
      return { ok: true, added: 0, updated: 0, removed: 0, channelCount: source.channelCount };
    }

    const includePattern = tryCompilePattern(source.includeGroupsPattern);
    if (source.includeGroupsPattern && !includePattern) {
      this.log.warn(
        `Source #${source.id} includeGroupsPattern "${source.includeGroupsPattern}" is invalid, ignoring it (every group imports)`,
      );
    }
    const excludePattern = tryCompilePattern(source.excludeGroupsPattern);
    if (source.excludeGroupsPattern && !excludePattern) {
      this.log.warn(
        `Source #${source.id} excludeGroupsPattern "${source.excludeGroupsPattern}" is invalid, ignoring it (nothing is excluded)`,
      );
    }
    const { live, onDemandCount, groups } = classifyEntries(
      fetched.entries,
      includePattern,
      excludePattern,
    );

    // Deletions here cascade to channels, their numbering and every user's
    // favourites, so a response that lost most of the lineup is refused rather
    // than replayed: providers rate limit, ban and answer with stub pages.
    if (source.channelCount > 0 && live.length < source.channelCount * SUSPICIOUS_SHRINK_RATIO) {
      const message =
        `refresh returned ${live.length} live entries against ${source.channelCount} known: ` +
        'treating it as a truncated response and keeping the current lineup';
      await this.sourceRepo.update(source.id, {
        lastSyncAt: new Date(),
        lastSyncStatus: 'error',
        lastSyncError: message,
      });
      this.log.warn(`Sync "${source.name}" refused: ${message}`);
      return {
        ok: false,
        added: 0,
        updated: 0,
        removed: 0,
        channelCount: source.channelCount,
        error: message,
      };
    }

    const staleDays = await this.settingInt('livetv_stale_stream_days', 7);
    const { added, updated, removed } = await this.upsert(source, live, staleDays);
    await this.sourceRepo.update(source.id, {
      lastSyncAt: new Date(),
      lastSyncStatus: 'ok',
      lastSyncError: null,
      channelCount: live.length,
      guideUrls: fetched.guideUrls,
      playlistEtag: fetched.playlistEtag,
      playlistLastModified: fetched.playlistLastModified,
      expiresAt: fetched.expiresAt ?? source.expiresAt,
      accountStatus: fetched.accountStatus ?? source.accountStatus,
      maxStreams:
        !source.maxStreamsIsManual && fetched.maxConnections
          ? fetched.maxConnections
          : source.maxStreams,
    });
    this.log.log(
      `Sync "${source.name}": added=${added} updated=${updated} removed=${removed} ` +
        `(live=${live.length} onDemandSkipped=${onDemandCount})`,
    );

    try {
      await this.access.restrictAdultGroups(groups.map((g) => g.name));
    } catch (err) {
      this.log.warn(`Adult-group restriction pass failed: ${errorMessage(err)}`);
    }

    const touchedChannels = await this.channelRepo
      .createQueryBuilder('c')
      .innerJoin('c.streams', 's')
      .where('s."sourceId" = :sourceId', { sourceId: source.id })
      .andWhere('c.enabled = true')
      .getMany();
    this.logos
      .cacheLogos(touchedChannels.map((c) => ({ id: c.id, logoPath: c.logoPath })))
      .catch((err) => this.log.warn(`Logo cache pass failed: ${errorMessage(err)}`));

    return { ok: true, added, updated, removed, channelCount: live.length };
  }

  /** The guide URL for a source: the panel API for Xtream, the stored
   *  `x-tvg-url` for m3u (re-fetching the playlist is a last resort, only
   *  before the first successful sync has captured it). Reloads by id rather
   *  than trusting a passed-in entity, since `source.password` is only ever
   *  real when it comes back through `findOne`. */
  async resolveGuideUrl(sourceId: number): Promise<string> {
    const source = await this.findOne(sourceId);
    if (source.kind === 'xtream') {
      return new XtreamClient(credsOf(source), source.userAgent, source.referer).guideUrl();
    }
    if (source.guideUrls.length) return source.guideUrls[0];

    const res = await this.fetchM3uPlaylist(source.url, liveTvIdentityOf(source));
    if (res.notModified || !res.playlist.guideUrls.length) {
      throw new Error(`Source "${source.name}" playlist has no x-tvg-url header`);
    }
    return res.playlist.guideUrls[0];
  }

  // ---------------------------------------------------------------------------
  // Fetch: xtream vs m3u, unified into one normalized shape
  // ---------------------------------------------------------------------------

  private async fetchLineup(
    conn: ConnDescriptor,
    validators?: HttpCacheValidators | null,
  ): Promise<FetchedLineup | { notModified: true }> {
    if (conn.kind === 'xtream') {
      const client = new XtreamClient(
        { baseUrl: conn.url, username: conn.username ?? '', password: conn.password ?? '' },
        conn.userAgent ?? null,
        conn.referer ?? null,
      );
      const [account, streams] = await Promise.all([client.account(), client.liveStreams()]);
      const format = pickOutputFormat(account.allowedOutputFormats);
      return {
        notModified: false,
        entries: streams.map((s) => ({
          externalId: s.streamId,
          name: s.name,
          url: s.directSource || client.streamUrl(s.streamId, format),
          logo: s.logo,
          groupName: s.categoryName,
          tvgId: s.guideChannelId,
          number: s.number,
          qualityLabel: null,
          shiftMinutes: 0,
          userAgent: null,
          referer: null,
        })),
        guideUrls: [client.guideUrl()],
        maxConnections: account.maxConnections || null,
        expiresAt: account.expiresAt,
        accountStatus: account.status,
        playlistEtag: null,
        playlistLastModified: null,
      };
    }

    const res = await this.fetchM3uPlaylist(conn.url, liveTvIdentityOf(conn), validators);
    if (res.notModified) return { notModified: true };
    return {
      notModified: false,
      entries: res.playlist.entries.map(normalizeM3uEntry),
      guideUrls: res.playlist.guideUrls,
      maxConnections: res.playlist.maxConnections,
      expiresAt: res.playlist.expiresAt,
      accountStatus: null,
      playlistEtag: res.etag ?? null,
      playlistLastModified: res.lastModified ?? null,
    };
  }

  /**
   * A playlist is a URL or a file on the server, including one an administrator
   * uploaded. A file has no ETag, so its mtime plays that role: an untouched
   * file answers "not modified" just like an unchanged URL.
   */
  private async fetchM3uPlaylist(
    url: string,
    identity: LiveTvRequestIdentity,
    validators?: HttpCacheValidators | null,
  ) {
    if (!isHttpSource(url)) {
      const { body, version } = await readLocalPlaylist(url);
      if (validators?.lastModified === version) return { notModified: true as const };
      return {
        notModified: false as const,
        playlist: parseM3u(body),
        etag: null,
        lastModified: version,
      };
    }

    const res = await liveTvGet<string>(
      url,
      identity,
      { responseType: 'text', transformResponse: (data: string) => data },
      validators,
    );
    if (isNotModified(res.status)) return { notModified: true as const };
    const body = typeof res.data === 'string' ? res.data : String(res.data);
    const { etag, lastModified } = readValidators(res.headers as Record<string, unknown>);
    return { notModified: false as const, playlist: parseM3u(body), etag, lastModified };
  }

  private async settingInt(key: string, fallback: number): Promise<number> {
    const raw = await this.settings.get(key);
    const n = raw != null ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(n) ? n : fallback;
  }

  // ---------------------------------------------------------------------------
  // Upsert: natural key (sourceId, externalId), duplicate folding across sources
  // ---------------------------------------------------------------------------

  private async upsert(
    source: LiveTvSource,
    entries: NormalizedEntry[],
    staleDays: number,
  ): Promise<{ added: number; updated: number; removed: number }> {
    return this.dataSource.transaction(async (manager) => {
      const channelRepo = manager.getRepository(LiveTvChannel);
      const streamRepo = manager.getRepository(LiveTvChannelStream);
      const now = new Date();

      const existingStreams = await streamRepo.find({
        where: { source: { id: source.id } },
      });
      const streamByExternalId = new Map(existingStreams.map((s) => [s.externalId, s]));

      // Every channel, not just the enabled ones: a channel is created disabled,
      // so folding a second source onto it has to work before anyone enables it.
      const allChannels = await channelRepo.find({ relations: ['streams'] });
      // A 20k-channel lineup makes this the hot path of every incremental sync:
      // a linear .find() per entry turns into O(n²) comparisons.
      const channelById = new Map(allChannels.map((c) => [c.id, c]));
      const channelsWithSourceStream = new Set(
        allChannels
          .filter((c) => c.streams.some((s) => s.sourceId === source.id))
          .map((c) => c.id),
      );
      const foldTargetsByName = new Map<string, LiveTvChannel>();
      for (const channel of allChannels) {
        if (channelsWithSourceStream.has(channel.id)) continue;
        const key = normalizeChannelName(channel.name);
        // First candidate wins: a later same-name channel is the ambiguous one.
        if (key && !foldTargetsByName.has(key)) foldTargetsByName.set(key, channel);
      }
      const foldPriority = new Map<number, number>();

      const seenExternalIds = new Set<string>();
      const newChannels: LiveTvChannel[] = [];
      /** Parallel to `newChannels`: the entry each one still needs a stream for. */
      const streamsForNewChannels: NormalizedEntry[] = [];
      const newStreams: LiveTvChannelStream[] = [];
      const updatedStreams: LiveTvChannelStream[] = [];
      const channelsToTouch: LiveTvChannel[] = [];

      for (const entry of entries) {
        seenExternalIds.add(entry.externalId);
        const existing = streamByExternalId.get(entry.externalId);
        if (existing) {
          existing.url = entry.url;
          existing.providerName = entry.name;
          existing.qualityLabel = entry.qualityLabel;
          existing.userAgent = entry.userAgent;
          existing.referer = entry.referer;
          existing.lastSeenAt = now;
          updatedStreams.push(existing);
          const channel = channelById.get(existing.channelId);
          if (channel && backfillGuideId(channel, entry.tvgId)) {
            channelsToTouch.push(channel);
          }
          continue;
        }

        const foldKey = normalizeChannelName(entry.name);
        const foldTarget = foldKey ? foldTargetsByName.get(foldKey) : undefined;
        if (foldTarget && !channelsWithSourceStream.has(foldTarget.id)) {
          const priority = foldPriority.get(foldTarget.id) ?? foldTarget.streams.length;
          foldPriority.set(foldTarget.id, priority + 1);
          // Never fold a second entry from this same sync onto the same target.
          channelsWithSourceStream.add(foldTarget.id);
          newStreams.push(
            streamRepo.create({
              channel: foldTarget,
              source,
              externalId: entry.externalId,
              url: entry.url,
              priority,
              qualityLabel: entry.qualityLabel,
              providerName: entry.name,
              userAgent: entry.userAgent,
              referer: entry.referer,
              lastSeenAt: now,
            }),
          );
          if (backfillGuideId(foldTarget, entry.tvgId)) channelsToTouch.push(foldTarget);
          continue;
        }

        // Disabled by default: an unreviewed playlist must never flood the lineup.
        newChannels.push(
          channelRepo.create({
            name: entry.name,
            number: entry.number,
            logoPath: entry.logo,
            groupName: entry.groupName,
            enabled: false,
            guideChannelId: entry.tvgId,
            guideMatchKind: null,
            guideShiftMinutes: entry.shiftMinutes,
          }),
        );
        streamsForNewChannels.push(entry);
      }

      // A stream row is built only once its channel has a real id: passing an
      // unsaved entity writes the row with a null FK and orphans the channel.
      if (newChannels.length) {
        const saved = await channelRepo.save(newChannels, { chunk: SAVE_CHUNK });
        saved.forEach((channel, i) => {
          const entry = streamsForNewChannels[i];
          newStreams.push(
            streamRepo.create({
              channel,
              source,
              externalId: entry.externalId,
              url: entry.url,
              priority: 0,
              qualityLabel: entry.qualityLabel,
              providerName: entry.name,
              userAgent: entry.userAgent,
              referer: entry.referer,
              lastSeenAt: now,
            }),
          );
        });
      }
      if (newStreams.length) await streamRepo.save(newStreams, { chunk: SAVE_CHUNK });
      if (updatedStreams.length) {
        await streamRepo.save(updatedStreams, { chunk: SAVE_CHUNK });
      }
      if (channelsToTouch.length) {
        await channelRepo.save(channelsToTouch, { chunk: SAVE_CHUNK });
      }

      // Absence from one fetch is not enough: only a row unseen for the full
      // grace window is actually gone, so a flaky refresh never nukes favourites.
      const cutoff = new Date(now.getTime() - staleDays * MS_PER_DAY);
      const removedStreams = existingStreams.filter(
        (s) => !seenExternalIds.has(s.externalId) && (!s.lastSeenAt || s.lastSeenAt < cutoff),
      );
      let removedCount = 0;
      if (removedStreams.length) {
        await streamRepo.delete(removedStreams.map((s) => s.id));
        removedCount = removedStreams.length;

        const affectedChannelIds = [...new Set(removedStreams.map((s) => s.channelId))];
        const remaining = await streamRepo
          .createQueryBuilder('s')
          .select('s."channelId"', 'channelId')
          .where('s."channelId" IN (:...ids)', { ids: affectedChannelIds })
          .groupBy('s."channelId"')
          .getRawMany<{ channelId: number }>();
        const stillHasStreams = new Set(remaining.map((r) => Number(r.channelId)));
        const emptyChannelIds = affectedChannelIds.filter(
          (id) => !stillHasStreams.has(id),
        );
        if (emptyChannelIds.length) await channelRepo.delete(emptyChannelIds);
      }

      return {
        added: newStreams.length,
        updated: updatedStreams.length,
        removed: removedCount,
      };
    });
  }
}

/** Splits a fetch into what would import as a channel and what would not,
 *  and tallies `group-title` across the live share so the admin can calibrate
 *  include/exclude patterns from what the playlist actually contains. */
export function classifyEntries(
  entries: NormalizedEntry[],
  includePattern: RegExp | null,
  excludePattern: RegExp | null,
): ClassifyResult {
  const candidateLive: NormalizedEntry[] = [];
  let onDemandCount = 0;
  const groupCounts = new Map<string, number>();

  for (const entry of entries) {
    if (isOnDemandUrl(entry.url)) {
      onDemandCount++;
      continue;
    }
    candidateLive.push(entry);
    const group = entry.groupName ?? '';
    groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
  }

  const groups = [...groupCounts.entries()]
    .map(([name, count]) => ({ name: name || '(none)', count }))
    .sort((a, b) => b.count - a.count);

  const live = candidateLive.filter((entry) => {
    const group = entry.groupName ?? '';
    if (excludePattern?.test(group)) return false;
    if (includePattern && !includePattern.test(group)) return false;
    return true;
  });

  return { live, onDemandCount, groups };
}

/** Validates a pattern at save/preview time; a bad regex is the admin's typo
 *  to fix now, not a reason to fail a scheduled sync later. */
export function compileGroupPattern(
  pattern: string | null | undefined,
  field: string,
): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    throw new BadRequestException(`${field} is not a valid regular expression: ${errorMessage(err)}`);
  }
}

/** Same compilation, but for the sync path: a pattern that somehow turned
 *  invalid after being saved is skipped rather than aborting the whole sync. */
export function tryCompilePattern(pattern: string | null | undefined): RegExp | null {
  try {
    return compileGroupPattern(pattern, 'pattern');
  } catch {
    return null;
  }
}

function normalizeM3uEntry(e: M3uEntry): NormalizedEntry {
  return {
    externalId: e.externalId,
    name: e.name,
    url: e.url,
    logo: e.logo,
    groupName: e.groupName,
    tvgId: e.tvgId,
    number: e.number,
    qualityLabel: e.attrs['tvg-quality'] ?? null,
    shiftMinutes: e.shiftMinutes,
    userAgent: e.userAgent,
    referer: e.referer,
  };
}

function connOf(source: LiveTvSource): ConnDescriptor {
  return {
    kind: source.kind,
    url: source.url,
    username: source.username,
    password: source.password,
    userAgent: source.userAgent,
    referer: source.referer,
  };
}

function credsOf(source: LiveTvSource): XtreamCredentials {
  return { baseUrl: source.url, username: source.username ?? '', password: source.password ?? '' };
}

/** Never overwrites a guide id the channel already carries. */
function backfillGuideId(channel: LiveTvChannel, tvgId: string | null): boolean {
  if (!tvgId || channel.guideChannelId) return false;
  channel.guideChannelId = tvgId;
  return true;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
