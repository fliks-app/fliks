import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { cpus, loadavg } from 'node:os';
import type { Request } from 'express';
import { SettingsService } from '../settings/settings.service';
import type { LiveSession, SessionKind } from '../streaming/live-session.service';
import { QoeAggregator, mergeSummaries, type StallLast } from './core/aggregate';
import { readCmcd } from './core/cmcd';
import { diagnose } from './core/diagnose';
import type {
  QoeDiagnosis,
  QoeEvent,
  QoePipeline,
  QoeSample,
  QoeSessionSummary,
  QoeVerdict,
  ServerLoad,
} from './core/types';
import { PlaybackQoeEvent } from './entities/playback-qoe-event.entity';
import { PlaybackQoeSession } from './entities/playback-qoe-session.entity';

const FLUSH_INTERVAL_MS = 30_000;
/** Matches the LiveSession revive window: a GC'd session may still come back. */
const TRACKER_IDLE_MS = 20 * 60_000;
const MAX_EVENTS_PER_SESSION = 200;
/** A shorter wait means the segment was already there: no production-speed signal. */
const MIN_WAIT_MS = 20;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_SUMMARY_ROWS = 50_000;

export const QOE_ENABLED_KEY = 'qoe_enabled';
export const QOE_RETENTION_DAYS_KEY = 'qoe_retention_days';

/** A LiveSession, or any session shaped like one (live TV: no media file, kind 'live'). */
export type SessionRef = Pick<
  LiveSession,
  | 'sessionId'
  | 'userId'
  | 'mediaTitle'
  | 'startedAt'
  | 'lastBeat'
  | 'deviceLabel'
  | 'systemName'
  | 'appVersion'
  | 'quality'
  | 'transcodeReasons'
  | 'state'
  | 'attributedUserId'
> & { mediaFileId: number | null; kind: SessionKind | 'live' };

type QoeEventRow = Pick<PlaybackQoeEvent, 'sessionId' | 'at' | 'type' | 'data'>;

interface Tracker {
  session: SessionRef;
  playbackId: string | null;
  agg: QoeAggregator;
  pendingEvents: QoeEventRow[];
  eventCount: number;
  dirty: boolean;
  /** A sample or event arrived: only then is the session worth a row. */
  reported: boolean;
  endedAt: number | null;
  touchedAt: number;
  flushing: Promise<void> | null;
  /** A flush was requested while one was in flight. */
  flushAgain: boolean;
}

export interface QoeLiveSummary extends QoeDiagnosis {
  stallCount: number;
  stallMs: number;
  droppedPct: number | null;
  bandwidthBps: number | null;
  variantBitrate: number | null;
  bufferAheadS: number | null;
  hwDecoder: boolean | null;
  decoderName: string | null;
  transcodeSpeed: number | null;
  engine: QoeSessionSummary['engine'];
  /** The server parsed CMCD on this session's requests. */
  cmcd: boolean;
  cmcdClaimed: boolean;
  playbackId: string | null;
  lastStall: StallLast | null;
}

/** One viewing: the sessions sharing a playbackId (or a lone session), merged and re-diagnosed. */
export type QoePlayback = Omit<
  PlaybackQoeSession,
  'sessionId' | 'stallBufferAheadS' | 'stallBandwidthBps' | 'cmcdThroughputBps' | 'unrecoveredError' | 'sampleCount' | 'stallCauseMs' | 'stallReasonMs'
> & {
  /** The latest session of the playback. */
  sessionId: string;
  sessionIds: string[];
};

export interface QoeSessionQuery {
  days?: number;
  verdict?: QoeVerdict;
  userId?: number;
  device?: string;
  limit?: number;
  offset?: number;
}

export interface QoeDeviceSummary {
  device: string | null;
  engine: string | null;
  sessions: number;
  stallSessions: number;
  avgDroppedPct: number | null;
  hwDecoderPct: number | null;
  topVerdict: QoeVerdict;
}

const VERDICTS: QoeVerdict[] = [
  'ok',
  'network',
  'device',
  'server',
  'error',
  'unknown',
];

const rowSummary = (r: PlaybackQoeSession): QoeSessionSummary => ({
  engine: r.engine,
  cmcd: r.cmcd,
  cmcdClaimed: r.cmcdClaimed,
  videoCodec: r.videoCodec,
  width: r.width,
  height: r.height,
  decoderName: r.decoderName,
  hwDecoder: r.hwDecoder,
  watchedMs: r.watchedMs,
  stallCount: r.stallCount,
  stallMs: r.stallMs,
  droppedFrames: r.droppedFrames,
  decodedFrames: r.decodedFrames,
  recoveryReloads: r.recoveryReloads,
  errorCount: r.errorCount,
  unrecoveredError: r.unrecoveredError,
  bandwidthBps: null,
  variantBitrate: null,
  bufferAheadS: null,
  avgBandwidthBps: r.avgBandwidthBps,
  minBandwidthBps: r.minBandwidthBps,
  avgVariantBitrate: r.avgVariantBitrate,
  stallBufferAheadS: r.stallBufferAheadS,
  stallBandwidthBps: r.stallBandwidthBps,
  cmcdThroughputBps: r.cmcdThroughputBps,
  medianTranscodeSpeed: r.medianTranscodeSpeed,
  stallCauseMs: r.stallCauseMs,
  stallReasonMs: r.stallReasonMs,
  sampleCount: r.sampleCount,
});

/** A playbackId is only unique per user: another user's identical id must stay a separate playback. */
const KEY_SQL = `COALESCE(s."userId"::text || ':' || s."playbackId", s."sessionId")`;

const playbackKey = (r: PlaybackQoeSession) =>
  r.userId != null && r.playbackId != null
    ? `${r.userId}:${r.playbackId}`
    : r.sessionId;

/** Rows grouped by playback, each merged; newest playback first. */
function mergePlaybacks(rows: PlaybackQoeSession[]): QoePlayback[] {
  const groups = new Map<string, PlaybackQoeSession[]>();
  for (const r of rows) {
    const g = groups.get(playbackKey(r));
    if (g) g.push(r);
    else groups.set(playbackKey(r), [r]);
  }
  return [...groups.values()]
    .map((g) => {
      g.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
      const last = g[g.length - 1];
      const m = mergeSummaries(g.map(rowSummary));
      const d = diagnose(m, last.playMethod === 'live');
      const {
        stallBufferAheadS: _a,
        stallBandwidthBps: _b,
        cmcdThroughputBps: _c,
        unrecoveredError: _d,
        sampleCount: _e,
        stallCauseMs: _f,
        stallReasonMs: _g,
        ...rest
      } = last;
      return {
        ...rest,
        sessionId: last.sessionId,
        sessionIds: g.map((r) => r.sessionId),
        startedAt: g[0].startedAt,
        lastSeenAt: new Date(Math.max(...g.map((r) => r.lastSeenAt.getTime()))),
        engine: m.engine,
        cmcd: m.cmcd,
        cmcdClaimed: m.cmcdClaimed,
        videoCodec: m.videoCodec,
        width: m.width,
        height: m.height,
        decoderName: m.decoderName,
        hwDecoder: m.hwDecoder,
        watchedMs: m.watchedMs,
        stallCount: m.stallCount,
        stallMs: m.stallMs,
        droppedFrames: m.droppedFrames,
        decodedFrames: m.decodedFrames,
        avgBandwidthBps: m.avgBandwidthBps,
        minBandwidthBps: m.minBandwidthBps,
        avgVariantBitrate: m.avgVariantBitrate,
        recoveryReloads: m.recoveryReloads,
        errorCount: m.errorCount,
        medianTranscodeSpeed: m.medianTranscodeSpeed,
        verdict: d.verdict,
        confidence: d.confidence,
        reasons: d.reasons,
      };
    })
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}

const clampInt = (n: number) => Math.min(Math.max(Math.round(n), 0), 2 ** 31 - 1);

const droppedPct = (dropped: number | null, decoded: number | null) =>
  dropped != null && decoded ? (dropped / decoded) * 100 : null;

@Injectable()
export class QoeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(QoeService.name);
  private readonly trackers = new Map<string, Tracker>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private enabledFlag = true;
  private readonly transcodeProbes: (() => number)[] = [];
  private loadProbe: (() => Pick<ServerLoad, 'activeTranscodes' | 'activeSessions'>) | null = null;

  constructor(
    private readonly settings: SettingsService,
    @InjectRepository(PlaybackQoeSession)
    private readonly sessions: Repository<PlaybackQoeSession>,
    @InjectRepository(PlaybackQoeEvent)
    private readonly events: Repository<PlaybackQoeEvent>,
  ) {}

  onModuleInit(): void {
    const load = () =>
      this.settings
        .get(QOE_ENABLED_KEY)
        .then((v) => {
          this.enabledFlag = v !== 'false';
        })
        .catch(() => undefined);
    void load();
    this.settings.addChangeListener((key) => {
      if (key === QOE_ENABLED_KEY) void load();
    });
    this.timer = setInterval(() => void this.sweep(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.trackers.values()].map((t) => this.flush(t)));
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  /** Starts tracking a session; nothing is stored until a sample or event arrives. */
  register(session: SessionRef): void {
    this.track(session);
  }

  recordSample(session: SessionRef, sample: QoeSample): void {
    const t = this.track(session);
    if (!t) return;
    t.reported = true;
    t.playbackId = sample.playbackId ?? t.playbackId;
    t.agg.addSample(sample, Date.now(), session.state !== 'paused');
  }

  /** Server-side production timing of one segment, for sessions with no segment route of ours. */
  recordProduction(session: SessionRef, segmentDurationS: number, waitedMs: number): void {
    this.track(session, false)?.agg.addSegment({ segmentDurationS, waitedMs });
  }

  /** The streaming side tells how many transcodes and sessions run; the rest of the load is read here. */
  setLoadProbe(probe: () => Pick<ServerLoad, 'activeTranscodes' | 'activeSessions'>): void {
    this.loadProbe = probe;
  }

  /** Another source of running transcodes (live TV), added to the count. */
  addTranscodeProbe(probe: () => number): void {
    this.transcodeProbes.push(probe);
  }

  /** The rung the session is actually encoding, once segments are served. */
  noteServedRung(session: SessionRef, quality: string, bitrate: number | null): void {
    const t = this.trackers.get(session.sessionId);
    if (!t) return;
    const p = t.agg.pipeline;
    if (p?.output && (p.output.quality !== quality || (bitrate != null && p.output.bitrate !== bitrate))) {
      t.agg.setPipeline({ ...p, output: { ...p.output, quality, bitrate: bitrate ?? p.output.bitrate } });
      t.dirty = true;
    }
  }

  /** The run fell back from the GPU to the CPU: the pipeline follows it. */
  noteHwAccel(session: SessionRef, hw: string | undefined): void {
    if (hw !== 'none') return;
    const t = this.trackers.get(session.sessionId);
    const p = t?.agg.pipeline;
    if (!t || !p || (!p.encode?.hw && !p.decode?.hw)) return;
    const cpu = { hw: false, kind: 'cpu', name: null };
    t.agg.setPipeline({
      ...p,
      decode: p.decode && cpu,
      encode: p.encode && cpu,
      tonemap: p.tonemap && 'cpu',
    });
    t.dirty = true;
  }

  /** What the server does to this session's stream; replaces a previous value. */
  setPipeline(session: SessionRef, pipeline: QoePipeline): void {
    const t = this.track(session, false);
    if (t) t.agg.setPipeline(pipeline);
  }

  /** The rung changed on a running session: only the output differs. */
  updatePipelineOutput(session: SessionRef, quality: string | null, bitrate: number | null): void {
    const t = this.trackers.get(session.sessionId);
    const p = t?.agg.pipeline;
    if (!t || !p?.output) return;
    if (p.output.quality === quality && p.output.bitrate === bitrate) return;
    t.agg.setPipeline({ ...p, output: { ...p.output, quality, bitrate } });
    t.dirty = true;
  }

  private serverLoad(): ServerLoad | null {
    try {
      const counts = this.loadProbe?.() ?? { activeTranscodes: 0, activeSessions: 0 };
      const extra = this.transcodeProbes.reduce((n, p) => n + p(), 0);
      return {
        activeTranscodes: counts.activeTranscodes + extra,
        activeSessions: counts.activeSessions,
        loadAvg1: process.platform === 'win32' ? null : loadavg()[0],
        cpuCount: cpus().length,
      };
    } catch {
      return null;
    }
  }

  recordEvents(
    session: SessionRef,
    events: QoeEvent[],
    playbackId: string | null = null,
  ): void {
    const t = this.track(session, false);
    if (!t) return;
    t.reported = true;
    t.playbackId = playbackId ?? t.playbackId;
    const now = Date.now();
    const load = events.some((e) => e.type === 'stall') ? this.serverLoad() : null;
    for (const e of events) {
      if (t.eventCount >= MAX_EVENTS_PER_SESSION) break;
      t.eventCount++;
      const c = t.agg.addEvent(e, now, { live: session.kind === 'live', load });
      const { type, at, ...data } = e;
      t.pendingEvents.push({
        sessionId: session.sessionId,
        at: new Date(at),
        type,
        data: c
          ? {
              ...data,
              cause: c.cause,
              causeConfidence: c.confidence,
              causeReason: c.reason,
              causeEvidence: c.evidence,
              causeHints: c.hints,
              serverLoad: load,
            }
          : data,
      });
    }
  }

  /** Reads CMCD off the request; the caller measured `waitedMs` for the segment to be produced. */
  observeSegment(
    session: SessionRef | null,
    req: Request,
    segmentDurationS: number,
    waitedMs: number | null,
  ): void {
    if (!session || !this.enabledFlag) return;
    const t = this.track(session);
    if (!t) return;
    const cmcd = readCmcd(req);
    if (cmcd) t.agg.addCmcd(cmcd);
    t.agg.addSegment({
      segmentDurationS,
      waitedMs: waitedMs != null && waitedMs >= MIN_WAIT_MS ? waitedMs : null,
    });
  }

  /** Live view for the admin streams list; null when nothing was reported. */
  liveSummary(sessionId: string): QoeLiveSummary | null {
    const t = this.trackers.get(sessionId);
    if (!t) return null;
    const s = t.agg.summary();
    return {
      ...diagnose(s, t.session.kind === 'live'),
      stallCount: s.stallCount,
      stallMs: s.stallMs,
      droppedPct: droppedPct(s.droppedFrames, s.decodedFrames),
      bandwidthBps:
        s.bandwidthBps ?? s.cmcdThroughputBps,
      variantBitrate: s.variantBitrate,
      bufferAheadS: s.bufferAheadS,
      hwDecoder: s.hwDecoder,
      decoderName: s.decoderName,
      transcodeSpeed: s.medianTranscodeSpeed,
      engine: s.engine,
      cmcd: s.cmcd,
      cmcdClaimed: s.cmcdClaimed,
      playbackId: t.playbackId,
      lastStall: t.agg.lastStall,
    };
  }

  /** The session of a tracker kept after its end, so late events can still be owned and stored. */
  trackedSession(sessionId: string): SessionRef | null {
    return this.trackers.get(sessionId)?.session ?? null;
  }

  /** The session left the registry: flush now. The tracker stays for late events and a revive. */
  sessionEnded(session: SessionRef): void {
    const t = this.trackers.get(session.sessionId);
    if (!t) return;
    t.endedAt = Date.now();
    t.dirty = true;
    void this.flush(t);
  }

  private track(session: SessionRef, revive = true): Tracker | null {
    if (!this.enabledFlag) return null;
    let t = this.trackers.get(session.sessionId);
    if (!t) {
      t = {
        session,
        playbackId: null,
        agg: new QoeAggregator(),
        pendingEvents: [],
        eventCount: 0,
        dirty: false,
        reported: false,
        endedAt: null,
        touchedAt: 0,
        flushing: null,
        flushAgain: false,
      };
      this.trackers.set(session.sessionId, t);
    }
    t.session = session;
    if (revive) t.endedAt = null;
    t.dirty = true;
    t.touchedAt = Date.now();
    return t;
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, t] of this.trackers) {
      if (t.dirty) await this.flush(t);
      if (now - t.touchedAt > TRACKER_IDLE_MS && (!t.dirty || !t.reported)) {
        this.trackers.delete(id);
      }
    }
  }

  /** Resolves once everything dirty at call time is written; a call during a flush re-flushes after it. */
  private flush(t: Tracker): Promise<void> {
    if (t.flushing) {
      t.flushAgain = true;
      return t.flushing;
    }
    if (!t.dirty || !t.reported) return Promise.resolve();
    t.dirty = false;
    const events = t.pendingEvents.splice(0);
    const run = async (): Promise<void> => {
      try {
        const row = this.toRow(t);
        await this.sessions.upsert(row, ['sessionId']);
        await this.refreshPlaybackVerdict(row);
        if (events.length) await this.events.insert(events);
      } catch (e) {
        // bounded by the per-session event cap
        t.pendingEvents.unshift(...events);
        t.dirty = true;
        this.log.warn(
          `qoe flush failed for ${t.session.sessionId}: ${(e as Error).message}`,
        );
      } finally {
        t.flushing = null;
      }
      if (t.flushAgain) {
        t.flushAgain = false;
        await this.flush(t);
      }
    };
    t.flushing = run();
    return t.flushing;
  }

  /** The verdict covers every row of the playback, so a new row restates it on its siblings. */
  private async refreshPlaybackVerdict(row: PlaybackQoeSession): Promise<void> {
    const { userId, playbackId } = row;
    if (userId == null || playbackId == null) return;
    const rows = await this.sessions.find({ where: { userId, playbackId } });
    const p = mergePlaybacks(rows)[0];
    await this.sessions.update(
      { userId, playbackId },
      { playbackVerdict: p.verdict, playbackConfidence: p.confidence },
    );
  }

  private toRow(t: Tracker): PlaybackQoeSession {
    const s = t.agg.summary();
    const d = diagnose(s, t.session.kind === 'live');
    const ses = t.session;
    return this.sessions.create({
      sessionId: ses.sessionId,
      playbackId: t.playbackId,
      userId: ses.userId,
      mediaFileId: ses.mediaFileId,
      mediaTitle: ses.mediaTitle?.slice(0, 255) ?? null,
      startedAt: new Date(ses.startedAt),
      lastSeenAt: new Date(t.endedAt ?? Math.max(ses.lastBeat, t.touchedAt)),
      endedAt: t.endedAt ? new Date(t.endedAt) : null,
      deviceLabel: ses.deviceLabel,
      systemName: ses.systemName,
      appVersion: ses.appVersion,
      engine: s.engine,
      cmcd: s.cmcd,
      cmcdClaimed: s.cmcdClaimed,
      playMethod: ses.kind,
      quality: ses.quality ?? t.agg.pipeline?.output?.requested ?? null,
      transcodeReasons: ses.transcodeReasons ?? [],
      videoCodec: s.videoCodec,
      width: s.width,
      height: s.height,
      decoderName: s.decoderName,
      hwDecoder: s.hwDecoder,
      watchedMs: clampInt(s.watchedMs),
      stallCount: clampInt(s.stallCount),
      stallMs: clampInt(s.stallMs),
      droppedFrames: s.droppedFrames == null ? null : clampInt(s.droppedFrames),
      decodedFrames: s.decodedFrames == null ? null : clampInt(s.decodedFrames),
      avgBandwidthBps: s.avgBandwidthBps,
      minBandwidthBps: s.minBandwidthBps,
      avgVariantBitrate: s.avgVariantBitrate,
      recoveryReloads: clampInt(s.recoveryReloads),
      errorCount: clampInt(s.errorCount),
      medianTranscodeSpeed: s.medianTranscodeSpeed,
      stallBufferAheadS: s.stallBufferAheadS,
      stallBandwidthBps: s.stallBandwidthBps,
      cmcdThroughputBps: s.cmcdThroughputBps,
      stallCauseMs: s.stallCauseMs,
      stallReasonMs: s.stallReasonMs,
      pipeline: t.agg.pipeline,
      unrecoveredError: s.unrecoveredError,
      sampleCount: s.sampleCount,
      verdict: d.verdict,
      confidence: d.confidence,
      reasons: d.reasons,
      playbackVerdict: d.verdict,
      playbackConfidence: d.confidence,
    });
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purgeOld(): Promise<void> {
    const raw = Number(await this.settings.get(QOE_RETENTION_DAYS_KEY));
    const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const res = await this.sessions
      .createQueryBuilder()
      .delete()
      .where('"lastSeenAt" < :cutoff', { cutoff })
      .execute();
    if (res.affected) this.log.log(`purged ${res.affected} qoe session(s)`);
  }

  // ── Admin reads ──

  /** Playbacks (a user's sessions sharing a playbackId, merged), newest first. */
  async listSessions(q: QoeSessionQuery) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const qb = this.sessions
      .createQueryBuilder('s')
      .select(KEY_SQL, 'key')
      .addSelect('MAX(s."lastSeenAt")', 'last')
      .addSelect('MAX(s."userId")', 'uid')
      .addSelect('MAX(s."playbackId")', 'pid')
      .addSelect('COUNT(*) OVER()', 'total')
      .groupBy(KEY_SQL)
      .having('MAX(s."lastSeenAt") >= :since', { since: this.since(q.days ?? 7) })
      .orderBy('last', 'DESC')
      .limit(limit)
      .offset(Math.max(q.offset ?? 0, 0));
    if (q.verdict) qb.andWhere('s."playbackVerdict" = :v', { v: q.verdict });
    if (q.userId != null) qb.andWhere('s."userId" = :u', { u: q.userId });
    if (q.device) qb.andWhere('s."deviceLabel" = :d', { d: q.device });
    const page = await qb.getRawMany<{
      key: string;
      uid: number | null;
      pid: string | null;
      total: string;
    }>();
    return {
      items: await this.rowsOf(page),
      total: page.length ? Number(page[0].total) : 0,
    };
  }

  private async rowsOf(
    page: { key: string; uid: number | null; pid: string | null }[],
  ): Promise<QoePlayback[]> {
    if (!page.length) return [];
    const grouped = page.filter((p) => p.uid != null && p.pid != null);
    const rows = await this.sessions
      .createQueryBuilder('s')
      .where('s."sessionId" = ANY(:sids)', {
        sids: page.filter((p) => !grouped.includes(p)).map((p) => p.key),
      })
      .orWhere(
        '(s."userId", s."playbackId") IN (SELECT * FROM unnest(:uids::int[], :pids::text[]))',
        { uids: grouped.map((p) => p.uid), pids: grouped.map((p) => p.pid) },
      )
      .getMany();
    return mergePlaybacks(rows);
  }

  /** The playback of a session: its user's rows sharing the session's playbackId. */
  async getSession(sessionId: string) {
    const anchor = await this.sessions.findOne({ where: { sessionId } });
    if (!anchor) return null;
    const rows =
      anchor.userId != null && anchor.playbackId != null
        ? await this.sessions.find({
            where: { userId: anchor.userId, playbackId: anchor.playbackId },
          })
        : [anchor];
    rows.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    const events = await this.events.find({
      where: { sessionId: In(rows.map((r) => r.sessionId)) },
      order: { at: 'ASC', id: 'ASC' },
    });
    return {
      ...mergePlaybacks(rows)[0],
      sessions: rows,
      events: events.map((e) => ({
        id: e.id,
        sessionId: e.sessionId,
        at: e.at,
        type: e.type,
        data: e.data,
      })),
    };
  }

  async summary(days = 7) {
    const latest = (col: string) =>
      `(ARRAY_AGG(s."${col}" ORDER BY s."lastSeenAt" DESC) FILTER (WHERE s."${col}" IS NOT NULL))[1]`;
    const both = (col: string) =>
      `SUM(CASE WHEN s."droppedFrames" IS NOT NULL AND s."decodedFrames" IS NOT NULL THEN s."${col}" END)`;
    const rows = await this.sessions
      .createQueryBuilder('s')
      .select(KEY_SQL, 'key')
      .addSelect('MAX(s."lastSeenAt")', 'last')
      .addSelect(latest('deviceLabel'), 'device')
      .addSelect(latest('engine'), 'engine')
      .addSelect(latest('hwDecoder'), 'hw')
      .addSelect('MAX(s."playbackVerdict")', 'verdict')
      .addSelect('SUM(s."stallCount")', 'stalls')
      .addSelect(both('droppedFrames'), 'dropped')
      .addSelect(both('decodedFrames'), 'decoded')
      .groupBy(KEY_SQL)
      .having('MAX(s."lastSeenAt") >= :since', { since: this.since(days) })
      .orderBy('last', 'DESC')
      .getRawMany<{
        device: string | null;
        engine: string | null;
        hw: boolean | null;
        verdict: QoeVerdict;
        stalls: string;
        dropped: string | null;
        decoded: string | null;
      }>();
    const byVerdict = Object.fromEntries(
      VERDICTS.map((v) => [v, 0]),
    ) as Record<QoeVerdict, number>;
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      byVerdict[r.verdict]++;
      const key = `${r.device ?? ''}\u0000${r.engine ?? ''}`;
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }
    const byDevice: QoeDeviceSummary[] = [...groups.values()]
      .map((g) => {
        const pcts = g
          .map((r) =>
            droppedPct(
              r.dropped == null ? null : Number(r.dropped),
              r.decoded == null ? null : Number(r.decoded),
            ),
          )
          .filter((p): p is number => p != null);
        const hw = g.filter((r) => r.hw != null);
        const counts = new Map<QoeVerdict, number>();
        for (const r of g) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
        const top = [...counts].sort((a, b) => b[1] - a[1])[0][0];
        return {
          device: g[0].device,
          engine: g[0].engine,
          sessions: g.length,
          stallSessions: g.filter((r) => Number(r.stalls) > 0).length,
          avgDroppedPct: pcts.length
            ? pcts.reduce((a, b) => a + b, 0) / pcts.length
            : null,
          hwDecoderPct: hw.length
            ? (hw.filter((r) => r.hw).length / hw.length) * 100
            : null,
          topVerdict: top,
        };
      })
      .sort((a, b) => b.sessions - a.sessions);
    return { byVerdict, byDevice };
  }

  private since(days: number): Date {
    return new Date(Date.now() - Math.min(Math.max(days, 1), 3650) * 86_400_000);
  }
}
