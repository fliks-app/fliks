import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChildProcess, execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { PassThrough, type Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import { TRANSCODE_DIR } from '../../../common/constants/paths';
import { TranscodingService } from '../../streaming/transcoding';
import { StreamLifetime } from '../../streaming/lifetime-constants';
import { LiveTvCapacityService } from './livetv-capacity.service';
import { LiveTvChannel } from '../entities/livetv-channel.entity';
import { LiveTvChannelStream } from '../entities/livetv-channel-stream.entity';
import { User } from '../../users/entities/user.entity';
import { SettingsService } from '../../settings/settings.service';
import { ActivityRegistryService } from '../../scheduler/activity-registry.service';
import { buildLiveFfmpegArgs } from './live-ffmpeg-args';
import { liveTvFfmpegHeaderArgs, liveTvGet, liveTvIdentityOf } from '../livetv-http';
import { liveTvAccountStateOf } from './livetv-sources.service';

export type LiveTvPlayMode = 'direct' | 'remux' | 'transcode';

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

/** One attached client. Tracked per viewer, not per session, because a session
 *  is shared: the dashboard reports who is watching, and a viewer that stops
 *  fetching has to expire on its own without evicting the others. */
export interface LiveTvViewer {
  userId: number | null;
  username: string | null;
  device: string | null;
  startedAt: number;
  lastSeenAt: number;
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

/** One upstream connection, shared by every viewer whose mode, container and
 *  bitrate cap match: the session key carries all three. */
export interface LiveTvSessionEntry {
  key: string;
  channelId: number;
  channelName: string;
  mode: LiveTvPlayMode;
  streamId: number;
  streamUrl: string;
  sourceId: number;
  /** '' for `direct` (no ffmpeg, nothing on disk). */
  dir: string;
  proc: ChildProcess | null;
  viewers: Map<string, LiveTvViewer>;
  createdAt: number;
  lastAccessAt: number;
  idleTimer: NodeJS.Timeout | null;
  watcher: fs.FSWatcher | null;
  stallTimer: NodeJS.Timeout | null;
  lastSegmentAt: number;
  failoverIndex: number;
  streamFailures: Map<number, number>;
  restarts: number;
  /** Set right before a deliberate stop so the exit/close handler skips failover. */
  intentionallyKilled: boolean;
  /** True while a `recover()` call owns retries; the async exit/stall handlers
   *  defer to it so two recovery attempts never race the same stream list. */
  starting: boolean;
  streams: LiveTvChannelStream[];
  segmentSeconds: number;
  windowMinutes: number;
  useTs: boolean;
  videoBitrateBps?: number;
  probeSeconds: number;
  /** The codec baked into the current fMP4 init segment while `mode === 'remux'`. */
  activeVideoCodec: string | null;
  /** Direct mode only: one PassThrough per viewer, keyed by its viewer token so a
   *  flowing tee can refresh that viewer's `lastSeenAt`. */
  directTees: Map<PassThrough, string> | null;
  directAbort: (() => void) | null;
  directContentType: string | null;
  /** Set when the upstream turned out to be a manifest, so direct play is off. */
  directNotStreamable: boolean;
  /** The real reason `connectDirect` failed to open the upstream; recover() reports
   *  it instead of the generic startup-timeout message when it's set. */
  lastConnectError: string | null;
}

const FIRST_SEGMENT_TIMEOUT_MS = 20_000;
/** No new segment (or, for direct, no new upstream data) this long while viewers are attached: treat as stalled. */
const STALL_TIMEOUT_MS = 15_000;
const STALL_CHECK_INTERVAL_MS = 5_000;
/** Every stream gets up to this many tries before the session gives up. */
const MAX_FAILURES_PER_STREAM = 2;
/** The only video codec every browser decodes from an fMP4 segment. Anything
 *  else is transcoded: ffmpeg copies MPEG-2 into fMP4 without complaint and the
 *  viewer gets a black screen while the server logs look healthy. */
const REMUXABLE_VIDEO = new Set(['h264']);
const PROBE_TIMEOUT_MS = 15_000;
/** Content types that describe a stream instead of being one. */
const MANIFEST_CONTENT_TYPES = ['mpegurl', 'dash+xml', 'application/xml', 'text/xml'];
/** ffprobe format names that describe a stream instead of being one. */
const MANIFEST_CONTAINERS = ['hls', 'applehttp', 'dash'];
/** Last field of an ffprobe csv line when it describes a stream, not the format. */
const PROBE_STREAM_TYPES = new Set(['video', 'audio', 'subtitle', 'data', 'attachment']);
/** Read from the payload when the content type lies: providers serve playlists
 *  as text/plain, and a raw GitHub URL always does. */
const MANIFEST_SIGNATURES = ['#EXTM3U', '<?xml', '<MPD'];
/** How long a connected upstream may stay silent before it counts as a stream.
 *  Past it the stall watchdog is the judge, as it is for every other silence. */
const DIRECT_SNIFF_MS = 4000;
/** Splits ffprobe's csv: stream rows end with their codec type, the format row
 *  does not, and a format name may itself hold commas (`mov,mp4,m4a,...`). */
export function parseProbeOutput(stdout: string): {
  video: string | null;
  audio: string | null;
  container: string | null;
} {
  let video: string | null = null;
  let audio: string | null = null;
  let container: string | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(',');
    const type = parts[parts.length - 1];
    if (!PROBE_STREAM_TYPES.has(type)) {
      container ??= line;
      continue;
    }
    if (type === 'video' && !video) video = parts[0];
    if (type === 'audio' && !audio) audio = parts[0];
  }
  return { video, audio, container };
}

/** True when a probed container is a playlist. Unknown fails open: an
 *  unrecognised container is still worth a direct attempt. */
export function isManifestContainer(container: string | null): boolean {
  if (!container) return false;
  return container.split(',').some((name) => MANIFEST_CONTAINERS.includes(name.trim().toLowerCase()));
}

/** True when the first bytes are a playlist rather than media. */
export function isManifestPayload(chunk: Buffer): boolean {
  // A playlist may open with a UTF-8 BOM (RFC 8216), which latin1 would keep as three chars.
  const from = chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf ? 3 : 0;
  const head = chunk.subarray(from, from + 16).toString('latin1').trimStart();
  return MANIFEST_SIGNATURES.some((sig) => head.startsWith(sig));
}

/** A direct viewer whose socket can't drain this much gets dropped rather than
 *  buffered forever; the shared upstream itself is never slowed down for it. */
const DIRECT_TEE_HIGH_WATER_MARK = 4 * 1024 * 1024;

/** Thrown by {@link LiveTvSessionService.openNewSession} when the upstream turned
 *  out to be a manifest: every caller sharing the attempt retries non-direct. */
class LiveTvDirectUnstreamable extends Error {}

@Injectable()
export class LiveTvSessionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LiveTvSessionService.name);
  private readonly liveRoot = path.join(TRANSCODE_DIR, 'live');
  private readonly sessions = new Map<string, LiveTvSessionEntry>();
  /** Key → in-flight {@link openNewSession} attempt, so concurrent opens for the
   *  same key share one upstream instead of each winning a `sessions.set` and
   *  orphaning the loser's ffmpeg/connection. ponytail: per-key promise map,
   *  in-process only; a second instance still double-opens. */
  private readonly opening = new Map<string, Promise<LiveTvSessionEntry>>();
  /** Per-viewer token (returned as `sessionId`) → the shared session's key. */
  private readonly viewerIndex = new Map<string, string>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(LiveTvChannel)
    private readonly channelRepo: Repository<LiveTvChannel>,
    @InjectRepository(LiveTvChannelStream)
    private readonly streamRepo: Repository<LiveTvChannelStream>,
    private readonly settings: SettingsService,
    private readonly activity: ActivityRegistryService,
    private readonly transcoding: TranscodingService,
    private readonly capacity: LiveTvCapacityService,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(
      () => this.sweepAbandoned(),
      StreamLifetime.liveSessionGcIntervalMs(),
    );
    this.sweepTimer.unref?.();
  }

  /**
   * A viewer only leaves by calling `leave()`. A killed tab, a slept phone or a
   * dropped connection never does, so its slot — and the provider connection
   * behind it — would be held for good. Serving the playlist keeps the session
   * fresh, so silence past the TTL means nobody is watching.
   */
  private sweepAbandoned(): void {
    const cutoff = Date.now() - StreamLifetime.liveSessionTtlMs();
    for (const session of [...this.sessions.values()]) {
      let dropped = 0;
      // A direct viewer polls nothing: its open response is the liveness signal,
      // and backpressure already drops the tee of a client that stopped reading.
      const streaming = new Set(session.directTees?.values() ?? []);
      for (const [viewerId, viewer] of [...session.viewers]) {
        if (viewer.lastSeenAt > cutoff || streaming.has(viewerId)) continue;
        session.viewers.delete(viewerId);
        this.viewerIndex.delete(viewerId);
        dropped++;
      }
      if (!dropped) continue;
      this.log.log(
        `Dropped ${dropped} stale viewer(s) from ${session.channelName}, ${session.viewers.size} left`,
      );
      this.reportActivity(session);
      if (session.viewers.size === 0) void this.armIdleTimer(session);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const session of this.sessions.values()) {
      this.clearWatchers(session);
      this.stopTransport(session);
      for (const tee of session.directTees?.keys() ?? []) tee.destroy();
    }
    this.sessions.clear();
    this.viewerIndex.clear();
    try {
      fs.rmSync(this.liveRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  // ---------------------------------------------------------------------------
  // Tune
  // ---------------------------------------------------------------------------

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

    const mode = await this.decideMode(caps);
    if (mode === 'direct') {
      // Settled once per stream and cached: opening a playlist directly ends the
      // session the moment it is read, and every attempt costs the channel a
      // recorded failure.
      await this.ensureProbed(streams[0]);
      if (isManifestContainer(streams[0].probedContainer)) {
        return this.open(channel, user, { ...caps, directPlay: false });
      }
    }
    const key = this.buildSessionKey(channel.id, mode, caps);

    let session: LiveTvSessionEntry;
    try {
      session = await this.acquireLiveSession(key, channel, streams, mode, caps);
    } catch (err) {
      if (err instanceof LiveTvDirectUnstreamable) {
        this.log.log(`Channel ${channel.name} serves a manifest, packaging it instead`);
        return this.open(channel, user, { ...caps, directPlay: false });
      }
      throw err;
    }

    const sessionId = randomUUID();
    this.viewerIndex.set(sessionId, key);
    this.clearIdleTimer(session);
    session.viewers.set(sessionId, {
      userId: user?.id ?? null,
      username: user?.username ?? null,
      device: caps.userAgent ?? null,
      startedAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    session.lastAccessAt = Date.now();
    this.reportActivity(session);
    return this.describe(session, sessionId);
  }

  /** Resolves the shared session for `key`, retrying if it was torn down (e.g. the
   *  last viewer left first) between an in-flight attempt settling and this caller
   *  reading it: a dead session is never handed back, the key is reopened instead. */
  private async acquireLiveSession(
    key: string,
    channel: LiveTvChannel,
    streams: LiveTvChannelStream[],
    mode: LiveTvPlayMode,
    caps: ClientPlaybackCaps,
  ): Promise<LiveTvSessionEntry> {
    for (;;) {
      const session = await this.acquireSession(key, channel, streams, mode, caps);
      if (this.sessions.get(key) === session) return session;
    }
  }

  /** Coalesces concurrent opens for `key` onto one in-flight {@link openNewSession}
   *  attempt. The check for an existing session and the registration of a new
   *  attempt happen with no `await` between them, so two racing callers can't both
   *  fall through to create their own session for the same key. */
  private acquireSession(
    key: string,
    channel: LiveTvChannel,
    streams: LiveTvChannelStream[],
    mode: LiveTvPlayMode,
    caps: ClientPlaybackCaps,
  ): Promise<LiveTvSessionEntry> {
    const existing = this.sessions.get(key);
    if (existing) return Promise.resolve(existing);

    let attempt = this.opening.get(key);
    if (!attempt) {
      attempt = this.openNewSession(key, channel, streams, mode, caps).finally(() => {
        if (this.opening.get(key) === attempt) this.opening.delete(key);
      });
      this.opening.set(key, attempt);
    }
    return attempt;
  }

  /** Actually spawns/connects a fresh session for `key` and registers it. Never
   *  called directly outside {@link acquireSession}, which ensures only one runs
   *  per key at a time; a failure here must leave `key` free for the next caller. */
  private async openNewSession(
    key: string,
    channel: LiveTvChannel,
    streams: LiveTvChannelStream[],
    mode: LiveTvPlayMode,
    caps: ClientPlaybackCaps,
  ): Promise<LiveTvSessionEntry> {
    const grace = await this.settingInt('livetv_slot_release_seconds', 15);
    // Check-then-reserve with nothing async in between: two concurrent opens for
    // the same source would otherwise both pass the check before either is
    // registered in `this.sessions`, and both proceed past `maxStreams`.
    this.assertCapacity(streams[0], grace);
    this.capacity.reserve(streams[0].sourceId);

    let session: LiveTvSessionEntry;
    try {
      // The key stays on the requested mode: two viewers asking the same thing
      // share a session even when the probe downgrades both to a transcode.
      if (mode !== 'direct') await this.ensureProbed(streams[0]);
      const effectiveMode =
        mode === 'remux' && !REMUXABLE_VIDEO.has(streams[0].probedVideoCodec ?? '')
          ? 'transcode'
          : mode;

      const [segmentSeconds, windowMinutes, probeSeconds] = await Promise.all([
        this.settingInt('livetv_segment_seconds', 2),
        this.settingInt('livetv_timeshift_minutes', 15),
        this.settingInt('livetv_probe_seconds', 3),
      ]);

      session = {
        key,
        channelId: channel.id,
        channelName: channel.name,
        mode: effectiveMode,
        streamId: streams[0].id,
        streamUrl: streams[0].url,
        sourceId: streams[0].sourceId,
        dir: effectiveMode === 'direct' ? '' : path.join(this.liveRoot, key.replace(/[^a-z0-9-]/gi, '_')),
        proc: null,
        viewers: new Map(),
        createdAt: Date.now(),
        lastAccessAt: Date.now(),
        idleTimer: null,
        watcher: null,
        stallTimer: null,
        lastSegmentAt: Date.now(),
        failoverIndex: 0,
        streamFailures: new Map(),
        restarts: 0,
        intentionallyKilled: false,
        starting: true,
        streams,
        segmentSeconds,
        windowMinutes,
        useTs: caps.useTs === true,
        videoBitrateBps: caps.maxBitrateBps,
        probeSeconds,
        activeVideoCodec: effectiveMode === 'remux' ? (streams[0].probedVideoCodec ?? null) : null,
        directTees: effectiveMode === 'direct' ? new Map() : null,
        directAbort: null,
        directContentType: null,
        directNotStreamable: false,
        lastConnectError: null,
      };

      if (session.dir) fs.mkdirSync(session.dir, { recursive: true });
      this.sessions.set(key, session);
    } finally {
      // Registered in `this.sessions` (or never will be): either way `upstreamsOn`
      // now reflects reality on its own, so the temporary hold is no longer needed.
      this.capacity.releaseReservation(streams[0].sourceId);
    }

    const started = await this.recover(session, false);
    if (!started) {
      this.sessions.delete(key);
      if (session.directNotStreamable) throw new LiveTvDirectUnstreamable();
      // Every stream just failed; a source whose account is expired is worth
      // naming, since the generic message would send the viewer chasing a
      // network problem that isn't the real cause.
      const expiredStream = streams.find(
        (s) => liveTvAccountStateOf(s.source.expiresAt, s.source.accountStatus) === 'expired',
      );
      if (expiredStream) {
        throw new ServiceUnavailableException({
          code: 'livetv_account_expired',
          channelName: channel.name,
          sourceName: expiredStream.source.name,
        });
      }
      throw new ServiceUnavailableException({
        code: 'livetv_channel_unavailable',
        channelName: channel.name,
      });
    }
    return session;
  }

  async leave(sessionId: string): Promise<void> {
    const key = this.viewerIndex.get(sessionId);
    if (!key) return;
    this.viewerIndex.delete(sessionId);
    const session = this.sessions.get(key);
    if (!session) return;
    session.viewers.delete(sessionId);
    this.reportActivity(session);
    if (session.viewers.size === 0) await this.armIdleTimer(session);
  }

  /** One row per attached viewer, for the activity dashboard: a shared upstream
   *  still means several people watching, and the dashboard reports people. */
  listForActivity(): LiveTvActivityRow[] {
    const rows: LiveTvActivityRow[] = [];
    for (const session of this.sessions.values()) {
      const active = session.streams[session.failoverIndex];
      for (const [sessionId, viewer] of session.viewers) {
        rows.push({
          sessionId,
          channelId: session.channelId,
          channelName: session.channelName,
          mode: session.mode,
          userId: viewer.userId,
          username: viewer.username,
          device: viewer.device,
          startedAt: viewer.startedAt,
          lastSeenAt: viewer.lastSeenAt,
          videoCodec: session.activeVideoCodec ?? active?.probedVideoCodec ?? null,
          audioCodec: active?.probedAudioCodec ?? null,
          sourceName: active?.source?.name ?? null,
          container: session.mode === 'direct' || session.useTs ? 'mpegts' : 'fmp4',
          viewersOnUpstream: session.viewers.size,
        });
      }
    }
    return rows;
  }

  /** Resolves a viewer's token to the shared session, for the playlist/segment routes. */
  getForServe(sessionId: string): LiveTvSessionEntry | undefined {
    const key = this.viewerIndex.get(sessionId);
    if (!key) return undefined;
    const session = this.sessions.get(key);
    if (session) {
      const now = Date.now();
      session.lastAccessAt = now;
      const viewer = session.viewers.get(sessionId);
      if (viewer) viewer.lastSeenAt = now;
    }
    return session;
  }

  /** One PassThrough per viewer of a direct session; the shared upstream itself
   *  is opened once in {@link open} and is never re-opened here. */
  attachDirectViewer(session: LiveTvSessionEntry, viewerId: string): PassThrough {
    const tee = new PassThrough({ highWaterMark: DIRECT_TEE_HIGH_WATER_MARK });
    session.directTees?.set(tee, viewerId);
    return tee;
  }

  detachDirectViewer(session: LiveTvSessionEntry, tee: PassThrough): void {
    session.directTees?.delete(tee);
    tee.destroy();
  }

  private async decideMode(caps: ClientPlaybackCaps): Promise<LiveTvPlayMode> {
    if (caps.directPlay === true) return 'direct';
    if (caps.maxBitrateBps != null) return 'transcode';
    const override = await this.settings.get('livetv_fast_zap');
    if (override === 'true') return 'transcode';
    if (override === 'false') return 'remux';
    // Measured: transcoding reaches the first segment ~1.5s sooner than copying,
    // because we own the keyframe cadence. Only worth it when encoding is free.
    return this.transcoding.getDetectedHwAccel() !== 'none' ? 'transcode' : 'remux';
  }

  /** `channelId:mode:container:bitrate`: two viewers share ffmpeg only when
   *  they would actually decode the same output. */
  private buildSessionKey(channelId: number, mode: LiveTvPlayMode, caps: ClientPlaybackCaps): string {
    const container = caps.useTs ? 'ts' : 'fmp4';
    return `${channelId}:${mode}:${container}:${caps.maxBitrateBps ?? 0}`;
  }

  /** A stream with a live error sorts after a clean one; among ties, the most
   *  recently confirmed stream goes first. */
  private compareHealth(a: LiveTvChannelStream, b: LiveTvChannelStream): number {
    const aBad = a.lastError ? 1 : 0;
    const bBad = b.lastError ? 1 : 0;
    if (aBad !== bBad) return aBad - bBad;
    return (b.lastOkAt?.getTime() ?? 0) - (a.lastOkAt?.getTime() ?? 0);
  }

  /**
   * Probes the stream once, the first time anyone tunes it, and keeps the
   * answer on the row. A probe costs about three seconds and holds a provider
   * connection, so it is never run for a whole lineup at sync time.
   */
  private async ensureProbed(stream: LiveTvChannelStream): Promise<void> {
    if (stream.probedVideoCodec) return;
    this.capacity.beginProbe(stream.sourceId);
    try {
      const probed = await this.probeCodecs(stream);
      if (!probed) return; // Unreachable stream: failover will speak up.
      stream.probedVideoCodec = probed.video;
      stream.probedAudioCodec = probed.audio;
      stream.probedContainer = probed.container;
      void this.streamRepo.update(stream.id, {
        probedVideoCodec: probed.video,
        probedAudioCodec: probed.audio,
        probedContainer: probed.container,
      });
    } finally {
      this.capacity.endProbe(stream.sourceId);
    }
  }

  private probeCodecs(
    stream: LiveTvChannelStream,
  ): Promise<{ video: string | null; audio: string | null; container: string | null } | null> {
    const args = [
      '-v',
      'error',
      '-analyzeduration',
      '3000000',
      '-probesize',
      '5000000',
      '-show_entries',
      'format=format_name:stream=codec_type,codec_name',
      '-of',
      'csv=p=0',
      ...liveTvFfmpegHeaderArgs(liveTvIdentityOf(stream.source)),
      stream.url,
    ];
    return new Promise((resolve) => {
      execFile('ffprobe', args, { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
        if (err) {
          this.log.warn(`Probe failed for stream #${stream.id}: ${err.message}`);
          resolve(null);
          return;
        }
        resolve(parseProbeOutput(stdout));
      });
    });
  }

  private assertCapacity(primary: LiveTvChannelStream, grace: number): void {
    this.capacity.assertBelowLimit(primary.source, grace, this.upstreamsOn(primary.sourceId));
  }

  /** Open upstreams for a source, counted from the session map itself. */
  private upstreamsOn(sourceId: number): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.sourceId === sourceId) count++;
    }
    return count;
  }

  private describe(session: LiveTvSessionEntry, sessionId: string): LiveTvPlayResult {
    return {
      sessionId,
      channelId: session.channelId,
      channelName: session.channelName,
      // Absolute from the API root: the client hands this straight to its
      // playback engine, which knows nothing about the global route prefix.
      url:
        session.mode === 'direct'
          ? `/api/livetv/sessions/${sessionId}/direct.ts`
          : `/api/livetv/sessions/${sessionId}/index.m3u8`,
      mode: session.mode,
      isLive: true,
      dvrWindowSeconds: session.mode === 'direct' ? 0 : session.windowMinutes * 60,
      segmentSeconds: session.segmentSeconds,
    };
  }

  // ---------------------------------------------------------------------------
  // Spawn / connect / wait / failover
  // ---------------------------------------------------------------------------

  /**
   * Tries streams in priority-then-health order (each up to
   * {@link MAX_FAILURES_PER_STREAM} times) until one produces output within
   * {@link FIRST_SEGMENT_TIMEOUT_MS}, or every stream is exhausted (session ends).
   *
   * `session.starting` guards this against the async exit/stall handlers: only
   * one recovery attempt ever owns the stream list at a time. Set back to
   * `false` on success, once {@link armStallWatcher} takes over as the
   * steady-state failure detector.
   */
  private async recover(session: LiveTvSessionEntry, attemptedOnce: boolean): Promise<boolean> {
    session.starting = true;
    for (;;) {
      if (session.streams.every((s) => (session.streamFailures.get(s.id) ?? 0) >= MAX_FAILURES_PER_STREAM)) {
        await this.endSession(session);
        return false;
      }
      const stream = session.streams[session.failoverIndex % session.streams.length];
      if ((session.streamFailures.get(stream.id) ?? 0) >= MAX_FAILURES_PER_STREAM) {
        session.failoverIndex++;
        continue;
      }

      const ok =
        session.mode === 'direct'
          ? await this.connectDirect(session, stream)
          : await this.spawnPackagedAndWait(session, stream, attemptedOnce);
      attemptedOnce = true;

      if (ok) {
        void this.streamRepo.update(stream.id, { lastOkAt: new Date(), lastError: null });
        session.starting = false;
        this.armStallWatcher(session);
        return true;
      }

      this.stopTransport(session);
      const expired =
        liveTvAccountStateOf(stream.source.expiresAt, stream.source.accountStatus) === 'expired';
      const detail = expired
        ? 'account expired'
        : (session.lastConnectError ?? 'no segment produced within the startup window');
      session.lastConnectError = null;
      void this.streamRepo.update(stream.id, { lastError: detail });
      session.streamFailures.set(stream.id, (session.streamFailures.get(stream.id) ?? 0) + 1);
      session.failoverIndex++;
      session.restarts++;
    }
  }

  /** Probes the candidate first: a codec the running init segment can't
   *  describe forces a fresh transcode run instead of an append. */
  private async spawnPackagedAndWait(
    session: LiveTvSessionEntry,
    stream: LiveTvChannelStream,
    attemptedOnce: boolean,
  ): Promise<boolean> {
    await this.ensureProbed(stream);
    let freshRun = false;
    if (session.mode === 'remux' && this.forcesTranscode(stream, session.activeVideoCodec)) {
      session.mode = 'transcode';
      freshRun = true;
    }
    const append = !freshRun && attemptedOnce && fs.existsSync(path.join(session.dir, 'index.m3u8'));
    this.spawnInto(session, stream, append);
    const ok = await this.waitForFirstSegment(session);
    if (ok && session.mode === 'remux') session.activeVideoCodec = stream.probedVideoCodec ?? null;
    return ok;
  }

  /** True when remuxing this stream would produce output the current init
   *  segment (or no browser) can decode: unremuxable, or a different codec. */
  private forcesTranscode(stream: LiveTvChannelStream, activeVideoCodec: string | null): boolean {
    const codec = stream.probedVideoCodec ?? '';
    if (!REMUXABLE_VIDEO.has(codec)) return true;
    return activeVideoCodec != null && codec !== activeVideoCodec;
  }

  private spawnInto(session: LiveTvSessionEntry, stream: LiveTvChannelStream, append: boolean): void {
    const args = buildLiveFfmpegArgs({
      inputUrl: stream.url,
      outputDir: session.dir,
      segmentSeconds: session.segmentSeconds,
      windowMinutes: session.windowMinutes,
      mode: session.mode === 'transcode' ? 'transcode' : 'remux',
      useTs: session.useTs,
      ...liveTvIdentityOf(stream.source),
      hwAccel: session.mode === 'transcode' ? this.transcoding.getDetectedHwAccel() : 'none',
      videoBitrateBps: session.videoBitrateBps,
      audioCodec: stream.probedAudioCodec,
      append,
      probeSeconds: session.probeSeconds,
    });

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    session.proc = proc;
    session.streamId = stream.id;
    session.streamUrl = stream.url;
    session.sourceId = stream.sourceId;
    session.lastSegmentAt = Date.now();
    session.intentionallyKilled = false;

    let stderrTail = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    proc.on('exit', (code) => {
      // During a `recover()` attempt, its own poll loop owns retries, and an
      // exit here is already visible to it via `proc.exitCode`.
      if (session.intentionallyKilled || session.starting) return;
      const detail = stderrTail.slice(-300);
      this.log.warn(`Live TV session ${session.key} stream #${stream.id} exited (code=${code}): ${detail}`);
      void this.streamRepo.update(stream.id, { lastError: `exited (code=${code}): ${detail}` });
      void this.handleFailure(session);
    });
  }

  /** Opens the shared upstream for a direct session: resolves once the response
   *  headers arrive, then tees every future chunk to `directTees`. */
  private connectDirect(session: LiveTvSessionEntry, stream: LiveTvChannelStream): Promise<boolean> {
    session.sourceId = stream.sourceId;
    session.streamId = stream.id;
    session.streamUrl = stream.url;
    return new Promise((resolve) => {
      const controller = new AbortController();
      liveTvGet<Readable>(
        stream.url,
        liveTvIdentityOf(stream.source),
        { responseType: 'stream', signal: controller.signal },
      )
        .then((res) => {
          session.intentionallyKilled = false;
          session.lastSegmentAt = Date.now();
          session.directAbort = () => controller.abort();
          const contentType = String(res.headers['content-type'] ?? 'video/mp2t');
          session.directContentType = contentType;

          // A manifest describes a stream instead of being one: it ends as soon
          // as it is read, which would tear the session down moments after the
          // client was handed its URL. Say so, and let the caller package it.
          let settled = false;
          let sniffTimer: ReturnType<typeof setTimeout> | undefined;
          const settle = (streamable: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(sniffTimer);
            if (!streamable) {
              session.directNotStreamable = true;
              controller.abort();
            }
            resolve(streamable);
          };
          if (MANIFEST_CONTENT_TYPES.some((t) => contentType.toLowerCase().includes(t))) {
            settle(false);
            return;
          }
          sniffTimer = setTimeout(() => settle(true), DIRECT_SNIFF_MS);

          res.data.on('data', (chunk: Buffer) => {
            const now = Date.now();
            session.lastSegmentAt = now;
            if (!settled) {
              settle(!isManifestPayload(chunk));
              if (session.directNotStreamable) return;
            }
            for (const [tee] of session.directTees ?? []) {
              // A tee that cannot drain fast enough is dropped, never the upstream.
              if (!tee.write(chunk)) {
                tee.destroy();
                session.directTees?.delete(tee);
              }
            }
          });
          const onDown = (): void => {
            if (session.intentionallyKilled || session.starting) return;
            void this.handleFailure(session);
          };
          res.data.on('error', onDown);
          res.data.on('end', onDown);
        })
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          this.log.warn(`Live TV direct connect failed for stream #${stream.id}: ${detail}`);
          session.lastConnectError = detail;
          resolve(false);
        });
    });
  }

  private waitForFirstSegment(session: LiveTvSessionEntry): Promise<boolean> {
    const dir = session.dir;
    return new Promise((resolve) => {
      let settled = false;
      let watcher: fs.FSWatcher | null = null;
      // Declared ahead of `finish`: a segment already on disk settles before either is armed.
      let poll: ReturnType<typeof setInterval> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const hasSegment = (): boolean => {
        try {
          return fs.readdirSync(dir).some((f) => f.startsWith('seg-'));
        } catch {
          return false;
        }
      };

      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        watcher?.close();
        clearInterval(poll);
        clearTimeout(timer);
        resolve(ok);
      };

      try {
        watcher = fs.watch(dir, { persistent: false }, () => {
          if (hasSegment()) finish(true);
        });
      } catch {
        /* directory not there yet, the poll fallback covers it */
      }

      if (hasSegment()) {
        finish(true);
        return;
      }

      poll = setInterval(() => {
        if (hasSegment()) finish(true);
        else if (session.proc?.exitCode != null) finish(false);
      }, 300);

      timer = setTimeout(() => finish(false), FIRST_SEGMENT_TIMEOUT_MS);
    });
  }

  /** Persistent for the session's life: refreshes `lastSegmentAt` and drives the
   *  15 s stall check that promotes the next stream even when nothing ever exits. */
  private armStallWatcher(session: LiveTvSessionEntry): void {
    this.clearWatchers(session);
    try {
      session.watcher = fs.watch(session.dir, { persistent: false }, (_e, filename) => {
        if (filename?.toString().startsWith('seg-')) session.lastSegmentAt = Date.now();
      });
    } catch {
      /* no directory for direct mode, or briefly absent across a respawn; the interval still catches it */
    }
    session.stallTimer = setInterval(() => {
      if (Date.now() - session.lastSegmentAt > STALL_TIMEOUT_MS) {
        void this.handleFailure(session);
      }
    }, STALL_CHECK_INTERVAL_MS);
  }

  private clearWatchers(session: LiveTvSessionEntry): void {
    session.watcher?.close();
    session.watcher = null;
    if (session.stallTimer) clearInterval(session.stallTimer);
    session.stallTimer = null;
  }

  /** A running session lost its stream (exit, stall or upstream close): mark it
   *  failed and hand off to {@link recover}, which tries the next one in place. */
  private async handleFailure(session: LiveTvSessionEntry): Promise<void> {
    if (!this.sessions.has(session.key)) return; // already torn down
    if (session.starting) return; // a recovery attempt already owns the stream list
    this.clearWatchers(session);
    this.stopTransport(session);
    // Unlike a startup attempt that never connects, this was a live upstream:
    // the provider still counts it as open for a while after this close.
    this.capacity.recordRelease(session.sourceId);
    session.streamFailures.set(session.streamId, (session.streamFailures.get(session.streamId) ?? 0) + 1);
    session.failoverIndex++;
    session.restarts++;
    await this.recover(session, true);
  }

  private async endSession(session: LiveTvSessionEntry): Promise<void> {
    this.teardown(session);
    await this.channelRepo
      .createQueryBuilder()
      .update(LiveTvChannel)
      .set({ lastErrorAt: () => 'now()', consecutiveFailures: () => '"consecutiveFailures" + 1' })
      .where('id = :id', { id: session.channelId })
      .execute();
    this.log.warn(`Live TV session ${session.key} ended: every stream failed`);
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  /** Stops whatever is currently feeding the session (process or upstream
   *  request), without touching viewers or tees. */
  private stopTransport(session: LiveTvSessionEntry): void {
    if (session.mode === 'direct') {
      if (!session.directAbort) return;
      session.intentionallyKilled = true;
      session.directAbort();
      session.directAbort = null;
    } else {
      if (!session.proc) return;
      session.intentionallyKilled = true;
      session.proc.kill('SIGKILL');
      session.proc = null;
    }
  }

  private clearIdleTimer(session: LiveTvSessionEntry): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  private async armIdleTimer(session: LiveTvSessionEntry): Promise<void> {
    this.clearIdleTimer(session);
    const seconds = await this.settingInt('livetv_channel_idle_seconds', 30);
    if (session.viewers.size > 0) return; // a viewer rejoined while we awaited the setting
    session.idleTimer = setTimeout(() => this.teardown(session), seconds * 1000);
  }

  private teardown(session: LiveTvSessionEntry): void {
    if (this.sessions.get(session.key) !== session) return;
    this.sessions.delete(session.key);
    // A viewer only ever clears its own entry via `leave()`; one still attached
    // when every stream dies would otherwise dangle here forever.
    for (const viewerId of session.viewers.keys()) this.viewerIndex.delete(viewerId);
    this.clearIdleTimer(session);
    this.clearWatchers(session);
    this.stopTransport(session);
    this.capacity.recordRelease(session.sourceId);
    for (const tee of session.directTees?.keys() ?? []) tee.destroy();
    session.directTees?.clear();
    if (session.dir) fs.rm(session.dir, { recursive: true, force: true }, () => undefined);
    this.reportActivity(session, true);
  }

  // ---------------------------------------------------------------------------
  // Activity reporting
  // ---------------------------------------------------------------------------

  private reportActivity(session: LiveTvSessionEntry, removed = false): void {
    const id = `livetv:${session.key}`;
    if (removed || session.viewers.size === 0) {
      this.activity.remove(id);
      return;
    }
    this.activity.upsertRunning(id, 'livetv.viewing', { title: session.channelName }, session.viewers.size);
  }

  private async settingInt(key: string, fallback: number): Promise<number> {
    const raw = await this.settings.get(key);
    const n = raw != null ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(n) ? n : fallback;
  }
}
