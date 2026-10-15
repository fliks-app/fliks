import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  EngineError,
  EngineService,
  type EngineEvent,
  type LiveSnapshot,
  type LiveTvConfig,
} from '../../engine/engine.service';
import { readCmcdRaw } from '../../qoe/core/cmcd';
import { QoeService, type SessionRef } from '../../qoe/qoe.service';
import { EngineEventsService } from '../../streaming/services/engine-events.service';
import { toQoePipeline } from '../../streaming/services/engine-presence';
import { EngineLivetvConfigClient } from '../../bridge/engine-livetv-config.client';
import { SettingsService } from '../../settings/settings.service';
import { ActivityRegistryService } from '../../scheduler/activity-registry.service';
import { LiveTvCapacityService } from './livetv-capacity.service';
import { LiveTvChannel } from '../entities/livetv-channel.entity';
import { LiveTvChannelStream } from '../entities/livetv-channel-stream.entity';
import { User } from '../../users/entities/user.entity';
import { liveTvHeaders, liveTvIdentityOf } from '../livetv-http';
import { liveTvAccountStateOf } from './livetv-sources.service';

export type LiveTvPlayMode = LiveSnapshot['mode'];

export interface ClientPlaybackCaps {
  directPlay?: boolean;
  maxBitrateBps?: number;
  useTs?: boolean;
  /** Not a capability: carried along so the activity dashboard can name the
   *  device, the way it does for on-demand playback. */
  userAgent?: string | null;
}

export interface LiveTvPlayResult {
  sessionId: string;
  channelId: number;
  channelName: string;
  url: string;
  mode: LiveTvPlayMode;
  isLive: true;
  dvrWindowSeconds: number;
  segmentSeconds: number;
}

export interface LiveTvActivityRow {
  sessionId: string;
  channelId: number;
  channelName: string;
  mode: LiveTvPlayMode;
  userId: number | null;
  username: string | null;
  device: string | null;
  startedAt: number;
  lastSeenAt: number;
  videoCodec: string | null;
  audioCodec: string | null;
  sourceName: string | null;
  container: string;
  /** How many viewers share this one provider connection. */
  viewersOnUpstream: number;
}

/** One attached viewer: the engine's session id, kept with what the host reports on it. */
interface Viewer {
  channelId: number;
  channelName: string;
  userId: number | null;
  device: string | null;
  startedAt: number;
  capacityToken: string;
}

/** A provider connection the host accounts for, from the open that asked for it to `LiveReleased`. */
interface Hold {
  sourceId: number;
  channelId: number;
  /** The open's upstreams, or the channel's streams for a hold restored after a restart. */
  streams: LiveTvChannelStream[];
  /** Index of the upstream that feeds the session now. */
  fed: number | null;
  /** The engine has not answered the open yet. */
  pending: boolean;
  /** What the engine serves; null until its answer. */
  mode: LiveTvPlayMode | null;
}

const CONFIG_KEYS = [
  'livetv_segment_seconds',
  'livetv_timeshift_minutes',
  'livetv_probe_seconds',
  'livetv_channel_idle_seconds',
  'livetv_fast_zap',
] as const;

function intOr(raw: string | null, fallback: number): number {
  const n = raw != null ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** The host's side of live TV: the catalog, access and capacity policy around the engine's live
 *  runtime, which owns the upstream connections, the HLS output and the viewers' data plane. */
@Injectable()
export class LiveTvSessionService implements OnModuleInit {
  private readonly log = new Logger(LiveTvSessionService.name);
  private readonly viewers = new Map<string, Viewer>();
  /** Capacity token -> its hold. */
  private readonly holds = new Map<string, Hold>();
  private segmentSeconds = 2;

  constructor(
    @InjectRepository(LiveTvChannel)
    private readonly channelRepo: Repository<LiveTvChannel>,
    @InjectRepository(LiveTvChannelStream)
    private readonly streamRepo: Repository<LiveTvChannelStream>,
    private readonly settings: SettingsService,
    private readonly activity: ActivityRegistryService,
    private readonly capacity: LiveTvCapacityService,
    private readonly engine: EngineService,
    private readonly events: EngineEventsService,
    private readonly livetvConfig: EngineLivetvConfigClient,
    @Optional() private readonly qoe?: QoeService,
  ) {}

  onModuleInit(): void {
    this.events.onEvent((ev) => this.onEvent(ev));
    this.events.onResync(() => this.resync());
    this.qoe?.addTranscodeProbe(() => this.activeTranscodes());
    this.settings.addChangeListener((key) => {
      if ((CONFIG_KEYS as readonly string[]).includes(key))
        void this.pushConfig();
    });
    void this.engine.whenReady().then(() => this.pushConfig());
  }

  private async pushConfig(): Promise<void> {
    try {
      const [segment, timeshift, probe, idle, fastZap] = await Promise.all(
        CONFIG_KEYS.map((k) => this.settings.get(k)),
      );
      const config: LiveTvConfig = {
        segmentSeconds: Math.max(1, intOr(segment, 2)),
        timeshiftMinutes: Math.max(1, intOr(timeshift, 15)),
        probeSeconds: intOr(probe, 3),
        channelIdleSeconds: intOr(idle, 30),
        fastZap: fastZap === 'true' ? true : fastZap === 'false' ? false : null,
      };
      this.segmentSeconds = config.segmentSeconds!;
      await this.livetvConfig.put(config);
    } catch (err) {
      this.log.warn(`live TV config not pushed: ${(err as Error).message}`);
    }
  }

  /**
   * `channel.streams` must already be loaded, each with its `.source`
   * relation, ordered doesn't matter (sorted here by priority then health).
   */
  async open(
    channel: LiveTvChannel,
    user: User,
    caps: ClientPlaybackCaps,
  ): Promise<LiveTvPlayResult> {
    const streams = [...channel.streams].sort(
      (a, b) => a.priority - b.priority || this.compareHealth(a, b),
    );
    if (!streams.length) {
      throw new ServiceUnavailableException({
        code: 'livetv_channel_unavailable',
        channelName: channel.name,
      });
    }
    const primary = streams[0];
    const grace = intOr(
      await this.settings.get('livetv_slot_release_seconds'),
      15,
    );

    // Check and hold with nothing async between them: two concurrent opens on one source cannot both pass.
    const full = this.capacityVerdict(primary, grace);
    const token = randomUUID();
    this.holds.set(token, {
      sourceId: primary.sourceId,
      channelId: channel.id,
      streams,
      fed: null,
      pending: true,
      mode: null,
    });

    let res;
    try {
      res = await this.engine.openLive({
        channelId: String(channel.id),
        upstreams: streams.map((s) => ({
          url: s.url,
          priority: s.priority,
          headers: liveTvHeaders(liveTvIdentityOf(s.source)) as Record<
            string,
            string
          >,
          probedContainer: s.probedContainer,
          probedVideoCodec: s.probedVideoCodec,
          probedAudioCodec: s.probedAudioCodec,
        })),
        caps: {
          directPlay: caps.directPlay,
          maxBitrateBps: caps.maxBitrateBps,
          useTs: caps.useTs,
        },
        ownerId: String(user.id),
        capacityToken: token,
        atCapacity: full != null,
        tags: {
          channelName: channel.name,
          username: user.username ?? '',
          device: caps.userAgent ?? '',
        },
      });
    } catch (err) {
      throw await this.openFailed(err, token, channel, streams, full);
    }

    const hold = this.holds.get(token);
    if (res.capacityToken !== token) this.holds.delete(token);
    else if (hold) {
      hold.pending = false;
      hold.mode = res.mode;
    }

    const viewer: Viewer = {
      channelId: channel.id,
      channelName: channel.name,
      userId: user?.id ?? null,
      device: caps.userAgent ?? null,
      startedAt: Date.now(),
      capacityToken: res.capacityToken,
    };
    this.viewers.set(res.sessionId, viewer);
    this.reportActivity(res.capacityToken);
    const ref = this.qoeRefOf(res.sessionId, viewer);
    this.qoe?.register(ref);
    this.qoe?.setPipeline(ref, toQoePipeline(res.qoePipeline));
    return {
      sessionId: res.sessionId,
      channelId: channel.id,
      channelName: channel.name,
      url: res.playPath,
      mode: res.mode,
      isLive: true,
      dvrWindowSeconds: res.dvrWindowSeconds,
      segmentSeconds: res.segmentSeconds,
    };
  }

  /** The error to throw for a refused open, after giving the hold back. */
  private async openFailed(
    err: unknown,
    token: string,
    channel: LiveTvChannel,
    streams: LiveTvChannelStream[],
    full: ConflictException | null,
  ): Promise<unknown> {
    if (!(err instanceof EngineError)) {
      this.holds.delete(token);
      return err;
    }
    if (err.code === 'live_unavailable') {
      await this.release(token, 'failed');
      // A source whose account is expired is worth naming, as the viewer would otherwise chase a network problem.
      const expired = streams.find(
        (s) =>
          liveTvAccountStateOf(s.source.expiresAt, s.source.accountStatus) ===
          'expired',
      );
      return new ServiceUnavailableException(
        expired
          ? {
              code: 'livetv_account_expired',
              channelName: channel.name,
              sourceName: expired.source.name,
            }
          : { code: 'livetv_channel_unavailable', channelName: channel.name },
      );
    }
    this.holds.delete(token);
    return err.code === 'live_at_capacity' && full ? full : err;
  }

  /** Throws away nothing: the verdict becomes the 409 when the engine has to open an upstream. */
  private capacityVerdict(
    primary: LiveTvChannelStream,
    grace: number,
  ): ConflictException | null {
    try {
      this.capacity.assertBelowLimit(
        primary.source,
        grace,
        this.upstreamsOn(primary.sourceId),
      );
      return null;
    } catch (err) {
      if (err instanceof ConflictException) return err;
      throw err;
    }
  }

  /** Open upstreams for a source: the holds that sit on it. */
  private upstreamsOn(sourceId: number): number {
    let count = 0;
    for (const hold of this.holds.values())
      if (hold.sourceId === sourceId) count++;
    return count;
  }

  /** A stream with a live error sorts after a clean one; among ties, the most
   *  recently confirmed stream goes first. */
  private compareHealth(
    a: LiveTvChannelStream,
    b: LiveTvChannelStream,
  ): number {
    const aBad = a.lastError ? 1 : 0;
    const bBad = b.lastError ? 1 : 0;
    if (aBad !== bBad) return aBad - bBad;
    return (b.lastOkAt?.getTime() ?? 0) - (a.lastOkAt?.getTime() ?? 0);
  }

  async leave(sessionId: string): Promise<void> {
    await this.engine.deleteSession(sessionId);
    this.dropViewer(sessionId);
  }

  /** The attached viewer of an engine session id. */
  viewer(sessionId: string): { channelId: number } | undefined {
    return this.viewers.get(sessionId);
  }

  /** One row per attached viewer, for the activity dashboard: a shared upstream
   *  still means several people watching, and the dashboard reports people. */
  async listForActivity(): Promise<LiveTvActivityRow[]> {
    let snaps: LiveSnapshot[];
    try {
      snaps = await this.engine.listLive();
    } catch {
      return [];
    }
    return snaps.map((s) => ({
      sessionId: s.sessionId,
      channelId: Number(s.channelId),
      channelName: s.tags.channelName ?? '',
      mode: s.mode,
      userId: s.ownerId ? Number(s.ownerId) : null,
      username: s.tags.username || null,
      device: s.tags.device || null,
      startedAt: s.openedAtMs,
      lastSeenAt: s.lastSeenMs,
      videoCodec: s.videoCodec ?? null,
      audioCodec: s.audioCodec ?? null,
      sourceName:
        this.streamOf(this.holds.get(s.capacityToken), s)?.source?.name ?? null,
      container: s.container,
      viewersOnUpstream: s.viewersOnUpstream,
    }));
  }

  /** The viewer as a QoE session (kind 'live', channel as title). */
  private qoeRefOf(sessionId: string, v: Viewer): SessionRef {
    return {
      sessionId,
      userId: v.userId,
      mediaFileId: null,
      mediaTitle: v.channelName,
      startedAt: v.startedAt,
      lastBeat: Date.now(),
      deviceLabel: v.device,
      systemName: null,
      appVersion: null,
      kind: 'live',
      quality: null,
      transcodeReasons: [],
      state: 'playing',
      attributedUserId: null,
    };
  }

  /** The viewer's QoE session for the heartbeat route; null when unknown. */
  qoeRef(sessionId: string): SessionRef | null {
    const v = this.viewers.get(sessionId);
    return v ? this.qoeRefOf(sessionId, v) : null;
  }

  private dropViewer(sessionId: string): void {
    const v = this.viewers.get(sessionId);
    if (!v) return;
    this.viewers.delete(sessionId);
    this.qoe?.sessionEnded(this.qoeRefOf(sessionId, v));
    this.reportActivity(v.capacityToken);
  }

  private onEvent(ev: EngineEvent): void {
    switch (ev.type) {
      case 'LiveAttempt':
        void this.attempt(ev).catch((e: Error) =>
          this.log.warn(`live attempt: ${e.message}`),
        );
        break;
      case 'LiveReleased':
        void this.release(ev.capacityToken, ev.reason).catch((e: Error) =>
          this.log.warn(`live release: ${e.message}`),
        );
        break;
      case 'SessionEnded':
        this.dropViewer(ev.sessionId);
        break;
      case 'SegmentServed': {
        const v = this.viewers.get(ev.sessionId);
        if (!v) break;
        this.qoe?.observeServed(
          this.qoeRefOf(ev.sessionId, v),
          ev.cmcdRaw ? readCmcdRaw(ev.cmcdRaw) : null,
          this.segmentSeconds,
          ev.waitedMs,
        );
        break;
      }
    }
  }

  /** One upstream attempt of a session: its health, its probe, and where the hold sits. */
  private async attempt(
    ev: Extract<EngineEvent, { type: 'LiveAttempt' }>,
  ): Promise<void> {
    const hold = this.holds.get(ev.capacityToken);
    const stream = this.streamOf(hold, ev);
    if (!hold || !stream) return;
    const patch: Partial<LiveTvChannelStream> = {};
    if (ev.probe?.videoCodec) patch.probedVideoCodec = ev.probe.videoCodec;
    if (ev.probe?.audioCodec) patch.probedAudioCodec = ev.probe.audioCodec;
    if (ev.probe?.container) patch.probedContainer = ev.probe.container;
    if (!ev.error) {
      hold.sourceId = stream.sourceId;
      hold.fed = ev.upstream;
      // A remux of a non-H.264 upstream becomes a transcode: the engine's snapshot has the verdict.
      if (!hold.pending) void this.refreshModes();
      patch.lastOkAt = new Date();
      patch.lastError = null;
    } else {
      const expired =
        liveTvAccountStateOf(
          stream.source.expiresAt,
          stream.source.accountStatus,
        ) === 'expired';
      patch.lastError = expired ? 'account expired' : ev.error;
      // The provider still counts a connection that was live as open for a while after it closes.
      if (hold.fed === ev.upstream) {
        this.capacity.recordRelease(stream.sourceId);
        hold.fed = null;
      }
    }
    await this.streamRepo.update(stream.id, patch);
  }

  /** The session behind `token` is gone: its provider connection is free, after the release grace. */
  private async release(token: string, reason: string): Promise<void> {
    const hold = this.holds.get(token);
    if (!hold) return;
    this.holds.delete(token);
    this.capacity.recordRelease(hold.sourceId);
    this.activity.remove(`livetv:${token}`);
    if (reason !== 'failed') return;
    await this.channelRepo
      .createQueryBuilder()
      .update(LiveTvChannel)
      .set({
        lastErrorAt: () => 'now()',
        consecutiveFailures: () => '"consecutiveFailures" + 1',
      })
      .where('id = :id', { id: hold.channelId })
      .execute();
    this.log.warn(
      `Live TV channel #${hold.channelId} ended: every stream failed`,
    );
  }

  /** After an events (re)connect: viewers and holds follow what the engine still runs. */
  private async resync(): Promise<void> {
    const listedAt = Date.now();
    const snaps = await this.engine.listLive();
    const tokens = new Set(snaps.map((s) => s.capacityToken));
    await this.restoreHolds(snaps);
    const known = new Set(snaps.map((s) => s.sessionId));
    for (const s of snaps) {
      if (this.viewers.has(s.sessionId)) continue;
      this.viewers.set(s.sessionId, {
        channelId: Number(s.channelId),
        channelName: s.tags.channelName ?? '',
        userId: s.ownerId ? Number(s.ownerId) : null,
        device: s.tags.device || null,
        startedAt: s.openedAtMs,
        capacityToken: s.capacityToken,
      });
    }
    // One opened since the list was taken is not stale, only newer than it.
    for (const [sid, v] of [...this.viewers]) {
      if (!known.has(sid) && v.startedAt < listedAt) this.dropViewer(sid);
    }
    for (const [token, hold] of [...this.holds]) {
      if (!tokens.has(token) && !hold.pending)
        await this.release(token, 'shutdown');
    }
  }

  /** The stream an engine event or snapshot names: url and priority survive a restart. */
  private streamOf(
    hold: Pick<Hold, 'streams'> | undefined,
    at: { upstreamUrl: string; upstreamPriority: number },
  ): LiveTvChannelStream | undefined {
    return hold?.streams.find(
      (x) => x.url === at.upstreamUrl && x.priority === at.upstreamPriority,
    );
  }

  /** Holds for the sessions the engine runs that this process lost (a restart); their upstreams
   *  are the channel's streams. */
  private async restoreHolds(snaps: LiveSnapshot[]): Promise<void> {
    for (const s of snaps) {
      const hold = this.holds.get(s.capacityToken);
      if (hold) {
        hold.mode ??= s.mode;
        continue;
      }
      const channelId = Number(s.channelId);
      const streams = await this.streamRepo.find({
        where: { channelId },
        relations: ['source'],
      });
      const fed = this.streamOf({ streams }, s);
      if (!fed || this.holds.has(s.capacityToken)) continue;
      this.holds.set(s.capacityToken, {
        sourceId: fed.sourceId,
        channelId,
        streams,
        fed: s.upstream,
        pending: false,
        mode: s.mode,
      });
    }
  }

  private async refreshModes(): Promise<void> {
    for (const s of await this.engine.listLive().catch(() => [])) {
      const hold = this.holds.get(s.capacityToken);
      if (hold) hold.mode = s.mode;
    }
  }

  /** Running transcodes, one per hold: viewers of a session share its encoder. */
  private activeTranscodes(): number {
    return [...this.holds.values()].filter((h) => h.mode === 'transcode')
      .length;
  }

  private reportActivity(token: string): void {
    const mine = [...this.viewers.values()].filter(
      (v) => v.capacityToken === token,
    );
    const id = `livetv:${token}`;
    if (!mine.length) this.activity.remove(id);
    else
      this.activity.upsertRunning(
        id,
        'livetv.viewing',
        { title: mine[0].channelName },
        mine.length,
      );
  }
}
