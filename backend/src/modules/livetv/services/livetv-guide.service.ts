import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { createGunzip } from 'zlib';
import type { Readable } from 'stream';
import { LiveTvGuideSource } from '../entities/livetv-guide-source.entity';
import { LiveTvGuideChannel } from '../entities/livetv-guide-channel.entity';
import { LiveTvChannel } from '../entities/livetv-channel.entity';
import { LiveTvProgram } from '../entities/livetv-program.entity';
import { parseXmltvStream, type XmltvChannel } from '../parsing/xmltv.parser';
import {
  matchGuideChannels,
  pickHighestPriorityRows,
  type GuideAssignment,
} from '../parsing/guide-match';
import {
  liveTvGet,
  isNotModified,
  readValidators,
  type HttpCacheValidators,
} from '../livetv-http';
import { User } from '../../users/entities/user.entity';
import { SettingsService } from '../../settings/settings.service';
import { LiveTvSourcesService } from './livetv-sources.service';
import { LiveTvChannelsService, type LiveTvChannelListItem } from './livetv-channels.service';
import { CreateLiveTvGuideSourceDto } from '../dto/create-livetv-guide-source.dto';
import { UpdateLiveTvGuideSourceDto } from '../dto/update-livetv-guide-source.dto';

const FETCH_TIMEOUT_MS = 300_000;
const SAVE_CHUNK = 500;
const MS_PER_DAY = 86_400_000;
const DEFAULT_PAGE_SIZE = 50;
/** Search is a jump-to affordance, not a browse: one screen of hits is enough. */
const SEARCH_RESULT_LIMIT = 50;
/** Missing `stop` in the feed: assume a half-hour slot rather than reject the entry. */
const DEFAULT_PROGRAMME_MINUTES = 30;

export interface LiveTvGuideSyncResult {
  ok: boolean;
  programCount: number;
  channelsTouched: number;
  error?: string;
}

export interface LiveTvGuideMatchReport {
  total: number;
  byKind: { id: number; name: number; fuzzy: number; manual: number };
  unmatched: { channelId: number; name: string }[];
  candidates: { id: string; displayName: string; guideSourceId: number }[];
}

export interface LiveTvGuideWindowResult {
  channels: LiveTvChannelListItem[];
  programs: Record<string, LiveTvProgram[]>;
  page: number;
  pageSize: number;
  total: number;
}

export interface LiveTvOnNowEntry {
  channel: LiveTvChannelListItem;
  now: LiveTvProgram | null;
  next: LiveTvProgram | null;
}

export interface LiveTvOnNowResult {
  entries: LiveTvOnNowEntry[];
  page: number;
  pageSize: number;
  total: number;
}

/** Sniffed, not deduced: axios decompresses a `Content-Encoding: gzip` body and
 *  drops the header, so a `.gz` file and a gzip transport read identically. */
async function maybeGunzip(source: Readable): Promise<Readable> {
  const head: Buffer = await new Promise((resolve, reject) => {
    source.once('error', reject);
    source.once('readable', () => resolve((source.read(2) as Buffer) ?? Buffer.alloc(0)));
  });
  source.unshift(head);
  return head[0] === 0x1f && head[1] === 0x8b ? source.pipe(createGunzip()) : source;
}

@Injectable()
export class LiveTvGuideService {
  private readonly log = new Logger(LiveTvGuideService.name);

  constructor(
    @InjectRepository(LiveTvGuideSource)
    private readonly guideSourceRepo: Repository<LiveTvGuideSource>,
    @InjectRepository(LiveTvGuideChannel)
    private readonly guideChannelRepo: Repository<LiveTvGuideChannel>,
    @InjectRepository(LiveTvChannel)
    private readonly channelRepo: Repository<LiveTvChannel>,
    @InjectRepository(LiveTvProgram)
    private readonly programRepo: Repository<LiveTvProgram>,
    private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly sources: LiveTvSourcesService,
    private readonly channels: LiveTvChannelsService,
  ) {}

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  findAll(): Promise<LiveTvGuideSource[]> {
    return this.guideSourceRepo.find({ order: { name: 'ASC' } });
  }

  async findOne(id: number): Promise<LiveTvGuideSource> {
    const row = await this.guideSourceRepo.findOne({ where: { id }, relations: ['source'] });
    if (!row) throw new NotFoundException(`Guide source #${id} not found`);
    return row;
  }

  create(dto: CreateLiveTvGuideSourceDto): Promise<LiveTvGuideSource> {
    return this.guideSourceRepo.save(
      this.guideSourceRepo.create({
        ...dto,
        source: dto.sourceId != null ? ({ id: dto.sourceId } as never) : null,
      }),
    );
  }

  async update(id: number, dto: UpdateLiveTvGuideSourceDto): Promise<LiveTvGuideSource> {
    const row = await this.findOne(id);
    // A field left out of a partial PATCH is `undefined`, not absent: TS class
    // fields ([[Define]] semantics) still declare it, so Object.assign would
    // stamp `undefined` onto the returned entity even though the row is untouched.
    if (dto.name !== undefined) row.name = dto.name;
    if (dto.kind !== undefined) row.kind = dto.kind;
    if (dto.url !== undefined) row.url = dto.url;
    if (dto.refreshIntervalHours !== undefined) row.refreshIntervalHours = dto.refreshIntervalHours;
    if (dto.timezoneOffsetMinutes !== undefined) row.timezoneOffsetMinutes = dto.timezoneOffsetMinutes;
    if (dto.language !== undefined) row.language = dto.language;
    if (dto.priority !== undefined) row.priority = dto.priority;
    if (dto.enabled !== undefined) row.enabled = dto.enabled;
    if (dto.sourceId !== undefined) {
      row.source = dto.sourceId != null ? ({ id: dto.sourceId } as never) : null;
    }
    return this.guideSourceRepo.save(row);
  }

  async remove(id: number): Promise<void> {
    const row = await this.findOne(id);
    await this.guideSourceRepo.remove(row);
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /**
   * One fetch, one streamed pass. The XMLTV DTD guarantees every `<channel>`
   * comes before any `<programme>`, so the first programme seen is the exact
   * moment the feed's channel list is complete: that is when the persisted
   * channel table is written and the match pass runs, before a single
   * programme decision is made. There is no second pass and no re-fetch.
   */
  async syncGuideSource(id: number): Promise<LiveTvGuideSyncResult> {
    const guideSource = await this.findOne(id);

    try {
      const url = await this.resolveFeedUrl(guideSource);
      const pastDays = await this.settingInt('livetv_guide_days_past', 2);
      const futureDays = await this.settingInt('livetv_guide_days_future', 7);
      const now = Date.now();
      const windowStart = new Date(now - pastDays * MS_PER_DAY);
      const windowEnd = new Date(now + futureDays * MS_PER_DAY);

      const feedChannels: XmltvChannel[] = [];
      const accepted: LiveTvProgram[] = [];
      const touchedGuideIds = new Set<string>();
      let shiftByGuideId = new Map<string, number>();
      let wantedGuideIds = new Set<string>();
      let channelsMatched = false;

      const applyMatchPass = async (): Promise<void> => {
        await this.persistGuideChannels(guideSource.id, feedChannels);
        const allChannels = await this.channelRepo.find();
        const matchResult = matchGuideChannels(
          allChannels.map((c) => ({
            id: c.id,
            name: c.name,
            guideChannelId: c.guideChannelId,
            guideMatchKind: c.guideMatchKind,
          })),
          feedChannels,
        );
        const assignedGuideId = new Map(
          matchResult.assignments.map((a) => [a.channelId, a.guideChannelId]),
        );
        // One UPDATE per (guideChannelId, kind) pair, not one per channel: a
        // 15k-channel lineup would otherwise serialize 15k round trips inside
        // the request that is still streaming the feed.
        const byAssignment = new Map<
          string,
          { guideChannelId: string; kind: GuideAssignment['kind']; channelIds: number[] }
        >();
        for (const assignment of matchResult.assignments) {
          const key = `${assignment.kind}:${assignment.guideChannelId}`;
          const group = byAssignment.get(key);
          if (group) group.channelIds.push(assignment.channelId);
          else {
            byAssignment.set(key, {
              guideChannelId: assignment.guideChannelId,
              kind: assignment.kind,
              channelIds: [assignment.channelId],
            });
          }
        }
        for (const { guideChannelId, kind, channelIds } of byAssignment.values()) {
          await this.channelRepo.update(channelIds, {
            guideChannelId,
            guideMatchKind: kind,
          });
        }

        // Ingest stays scoped to enabled channels: a disabled channel's match is
        // now visible to the admin, but its programmes are never downloaded.
        shiftByGuideId = new Map();
        for (const channel of allChannels) {
          if (!channel.enabled) continue;
          const guideChannelId = assignedGuideId.get(channel.id) ?? channel.guideChannelId;
          if (guideChannelId && !shiftByGuideId.has(guideChannelId)) {
            shiftByGuideId.set(guideChannelId, channel.guideShiftMinutes);
          }
        }
        wantedGuideIds = new Set(shiftByGuideId.keys());
        channelsMatched = true;
      };

      const validators: HttpCacheValidators = {
        etag: guideSource.etag,
        lastModified: guideSource.lastModified,
      };
      const identity =
        guideSource.kind === 'source'
          ? { userAgent: guideSource.source?.userAgent, referer: guideSource.source?.referer }
          : {};
      const res = await liveTvGet<Readable>(
        url,
        identity,
        { responseType: 'stream', timeout: FETCH_TIMEOUT_MS, decompress: true },
        validators,
      );

      if (isNotModified(res.status)) {
        res.data.destroy();
        await this.guideSourceRepo.update(guideSource.id, {
          lastSyncAt: new Date(),
          lastSyncStatus: 'ok',
          lastSyncError: null,
        });
        this.log.log(`Guide sync "${guideSource.name}": not modified, nothing to do`);
        return { ok: true, programCount: guideSource.programCount, channelsTouched: 0 };
      }

      const body = await maybeGunzip(res.data);

      await parseXmltvStream(
        body,
        {
          onChannel: (channel) => feedChannels.push(channel),
          onProgramme: async (programme) => {
            if (!channelsMatched) await applyMatchPass();
            // The single biggest performance lever: drop everything that isn't
            // one of the few dozen enabled channels before it reaches Postgres.
            if (!wantedGuideIds.has(programme.channelId)) return;
            if (programme.startsAt >= windowEnd) return;
            const endsAt =
              programme.endsAt ??
              new Date(programme.startsAt.getTime() + DEFAULT_PROGRAMME_MINUTES * 60_000);
            if (endsAt <= windowStart) return;

            const shiftMs = (shiftByGuideId.get(programme.channelId) ?? 0) * 60_000;
            touchedGuideIds.add(programme.channelId);
            accepted.push(
              this.programRepo.create({
                guideSource: { id: guideSource.id } as LiveTvGuideSource,
                guideChannelId: programme.channelId,
                startsAt: new Date(programme.startsAt.getTime() + shiftMs),
                endsAt: new Date(endsAt.getTime() + shiftMs),
                title: programme.title,
                subtitle: programme.subtitle,
                description: programme.description,
                categories: programme.categories,
                iconUrl: programme.iconUrl,
                seasonNumber: programme.seasonNumber,
                episodeNumber: programme.episodeNumber,
                seriesId: programme.seriesId,
                isNew: programme.isNew,
                isLive: programme.isLive,
                rating: programme.rating,
                year: programme.year,
              }),
            );
          },
        },
        { offsetMinutes: guideSource.timezoneOffsetMinutes, language: guideSource.language ?? undefined },
      );

      // A channel-only feed (or an empty one) never triggers a programme, so
      // the match pass still has to run once before the sync is considered done.
      if (!channelsMatched) await applyMatchPass();

      await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(LiveTvProgram);
        // Replace per source, per channel and window: a sibling guide source's
        // rows, and a channel absent from this feed run, are both left alone.
        if (touchedGuideIds.size) {
          await repo
            .createQueryBuilder()
            .delete()
            .where('"guideSourceId" = :guideSourceId', { guideSourceId: guideSource.id })
            .andWhere('"guideChannelId" IN (:...ids)', { ids: [...touchedGuideIds] })
            .andWhere('"startsAt" < :windowEnd', { windowEnd })
            .andWhere('"endsAt" > :windowStart', { windowStart })
            .execute();
        }
        if (accepted.length) await repo.save(accepted, { chunk: SAVE_CHUNK });
      });

      const newValidators = readValidators(res.headers as Record<string, unknown>);
      await this.guideSourceRepo.update(guideSource.id, {
        lastSyncAt: new Date(),
        lastSyncStatus: 'ok',
        lastSyncError: null,
        programCount: accepted.length,
        etag: newValidators.etag,
        lastModified: newValidators.lastModified,
      });
      this.log.log(
        `Guide sync "${guideSource.name}": ${accepted.length} program(s) across ${touchedGuideIds.size} channel(s)`,
      );
      return { ok: true, programCount: accepted.length, channelsTouched: touchedGuideIds.size };
    } catch (err) {
      const message = errorMessage(err);
      await this.guideSourceRepo.update(id, {
        lastSyncAt: new Date(),
        lastSyncStatus: 'error',
        lastSyncError: message,
      });
      this.log.warn(`Guide sync #${id} failed: ${message}`);
      return { ok: false, programCount: 0, channelsTouched: 0, error: message };
    }
  }

  private async resolveFeedUrl(guideSource: LiveTvGuideSource): Promise<string> {
    if (guideSource.kind === 'xmltv') {
      if (!guideSource.url) throw new BadRequestException('Guide source has no URL');
      return guideSource.url;
    }
    if (guideSource.sourceId == null) {
      throw new BadRequestException('Guide source has no parent Live TV source');
    }
    return this.sources.resolveGuideUrl(guideSource.sourceId);
  }

  /** Full replace: the persisted list only ever needs to reflect the latest feed. */
  private async persistGuideChannels(guideSourceId: number, channels: XmltvChannel[]): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(LiveTvGuideChannel);
      await repo.delete({ guideSource: { id: guideSourceId } });
      if (channels.length) {
        await repo.save(
          channels.map((c) =>
            repo.create({
              guideSource: { id: guideSourceId } as LiveTvGuideSource,
              channelId: c.id,
              displayNames: c.displayNames,
              iconUrl: c.iconUrl,
            }),
          ),
          { chunk: SAVE_CHUNK },
        );
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Match report
  // ---------------------------------------------------------------------------

  /** Channel stats cover every channel, enabled or not, so an admin can fix a
   *  mapping before flipping a channel on. `candidates` is served from the
   *  persisted feed table, so the picker survives a restart. */
  async matchReport(guideSourceId?: number): Promise<LiveTvGuideMatchReport> {
    const channels = await this.channelRepo.find();
    const byKind = { id: 0, name: 0, fuzzy: 0, manual: 0 };
    const unmatched: { channelId: number; name: string }[] = [];
    for (const channel of channels) {
      if (channel.guideMatchKind) byKind[channel.guideMatchKind]++;
      else unmatched.push({ channelId: channel.id, name: channel.name });
    }

    const rows = await this.guideChannelRepo.find({
      where: guideSourceId != null ? { guideSource: { id: guideSourceId } } : {},
      order: { channelId: 'ASC' },
    });
    const candidates = rows.map((r) => ({
      id: r.channelId,
      displayName: r.displayNames[0] ?? r.channelId,
      guideSourceId: r.guideSourceId,
    }));
    return { total: channels.length, byKind, unmatched, candidates };
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  async guide(params: {
    from: Date;
    to: Date;
    group?: string;
    favoritesOnly?: boolean;
    page?: number;
    pageSize?: number;
    user: User;
  }): Promise<LiveTvGuideWindowResult> {
    const page = params.page ?? 1;
    const pageSize = Math.min(params.pageSize ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);

    const { items: pageChannels, total } = await this.channels.listPageForUser(
      params.user,
      { group: params.group, favoritesOnly: params.favoritesOnly },
      page,
      pageSize,
    );
    const guideIds = pageChannels
      .map((c) => c.guideChannelId)
      .filter((v): v is string => v != null);

    const programs: Record<string, LiveTvProgram[]> = {};
    if (guideIds.length) {
      const rows = await this.fetchRankedPrograms(guideIds, params.from, params.to);
      for (const row of rows) {
        (programs[row.guideChannelId] ??= []).push(row);
      }
    }

    return { channels: pageChannels, programs, page, pageSize, total };
  }

  /** Paginated the same way as the guide grid, favourites first: this is the
   *  page a household actually uses, and it must never return the whole lineup. */
  async onNow(
    user: User,
    filters: { group?: string; query?: string } = {},
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  ): Promise<LiveTvOnNowResult> {
    const size = Math.min(pageSize, DEFAULT_PAGE_SIZE);
    const { items: pageChannels, total } = await this.channels.listPageForUser(
      user,
      filters,
      page,
      size,
    );
    const guideIds = pageChannels
      .map((c) => c.guideChannelId)
      .filter((v): v is string => v != null);

    if (!guideIds.length) {
      return {
        entries: pageChannels.map((channel) => ({ channel, now: null, next: null })),
        page,
        pageSize: size,
        total,
      };
    }

    const now = new Date();
    // Twelve hours, not a day: this endpoint is polled, and only the current
    // programme and the one after it are ever read. A long overnight block still fits.
    const horizon = new Date(now.getTime() + 12 * 3600_000);
    const rows = await this.fetchRankedPrograms(guideIds, now, horizon);

    const byGuideId = new Map<string, LiveTvProgram[]>();
    for (const row of rows) {
      const list = byGuideId.get(row.guideChannelId);
      if (list) list.push(row);
      else byGuideId.set(row.guideChannelId, [row]);
    }

    const entries = pageChannels.map((channel) => {
      const list = channel.guideChannelId ? (byGuideId.get(channel.guideChannelId) ?? []) : [];
      const current = list.find((p) => p.startsAt <= now && now < p.endsAt) ?? null;
      const next = list.find((p) => p.startsAt > now) ?? null;
      return { channel, now: current, next };
    });
    return { entries, page, pageSize: size, total };
  }

  /** Ids are sequential, so the lookup must gate on the same visibility rule
   *  as every list: a program on a denied-group channel is a 404, not a leak. */
  async program(id: number, user: User): Promise<LiveTvProgram> {
    const program = await this.programRepo.findOne({ where: { id } });
    if (!program) throw new NotFoundException(`Program #${id} not found`);
    const visible = await this.channels.isGuideChannelVisibleToUser(
      user,
      program.guideChannelId,
    );
    if (!visible) throw new NotFoundException(`Program #${id} not found`);
    return program;
  }

  async search(user: User, q: string): Promise<{
    channels: LiveTvChannelListItem[];
    programs: LiveTvProgram[];
  }> {
    const { items: channels } = await this.channels.listPageForUser(
      user,
      { query: q },
      1,
      SEARCH_RESULT_LIMIT,
    );

    const pastDays = await this.settingInt('livetv_guide_days_past', 2);
    const futureDays = await this.settingInt('livetv_guide_days_future', 7);
    const now = Date.now();
    const from = new Date(now - pastDays * MS_PER_DAY);
    const to = new Date(now + futureDays * MS_PER_DAY);

    // Scoped to the caller's own lineup, exactly like the channel search just
    // above: an unfiltered program search leaks every denied group's titles.
    const guideChannelIds = await this.channels.authorizedGuideChannelIds(user);
    const programs = guideChannelIds.length
      ? await this.programRepo
          .createQueryBuilder('p')
          .where('p."guideChannelId" IN (:...guideChannelIds)', { guideChannelIds })
          .andWhere('p.title ILIKE :q', { q: `%${q}%` })
          .andWhere('p."startsAt" < :to', { to })
          .andWhere('p."endsAt" > :from', { from })
          .orderBy('p."startsAt"', 'ASC')
          .take(50)
          .getMany()
      : [];

    return { channels, programs };
  }

  /** Both sides are bounded: lowering `livetv_guide_days_future` must reclaim
   *  the now-out-of-window rows too, not just let the past side shrink. */
  async prune(): Promise<{ removed: number }> {
    const pastDays = await this.settingInt('livetv_guide_days_past', 2);
    const futureDays = await this.settingInt('livetv_guide_days_future', 7);
    const now = Date.now();
    const pastCutoff = new Date(now - pastDays * MS_PER_DAY);
    const futureCutoff = new Date(now + futureDays * MS_PER_DAY);
    const res = await this.programRepo
      .createQueryBuilder()
      .delete()
      .where('"endsAt" < :pastCutoff', { pastCutoff })
      .orWhere('"startsAt" > :futureCutoff', { futureCutoff })
      .execute();
    return { removed: res.affected ?? 0 };
  }

  /** For a channel id two guide sources both define (rare, but real), only the
   *  higher-priority source's rows are returned; the query itself stays a
   *  single indexed lookup, the dedup runs in memory over the small result. */
  private async fetchRankedPrograms(
    guideChannelIds: string[],
    from: Date,
    to: Date,
  ): Promise<LiveTvProgram[]> {
    const rows = await this.programRepo
      .createQueryBuilder('p')
      .where('p."guideChannelId" IN (:...ids)', { ids: guideChannelIds })
      .andWhere('p."startsAt" < :to', { to })
      .andWhere('p."endsAt" > :from', { from })
      .orderBy('p."startsAt"', 'ASC')
      .getMany();
    if (rows.length < 2) return rows;

    const sources = await this.guideSourceRepo.find();
    const priorityBySourceId = new Map(sources.map((s) => [s.id, s.priority]));
    return pickHighestPriorityRows(rows, priorityBySourceId);
  }

  private async settingInt(key: string, fallback: number): Promise<number> {
    const raw = await this.settings.get(key);
    const n = raw != null ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(n) ? n : fallback;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
