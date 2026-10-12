import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import type { Request } from 'express';
import { SettingsService } from '../settings/settings.service';
import type { LiveSession } from '../streaming/live-session.service';
import { QoeAggregator } from './core/aggregate';
import { readCmcd } from './core/cmcd';
import { diagnose } from './core/diagnose';
import type {
  QoeDiagnosis,
  QoeEvent,
  QoeSample,
  QoeSessionSummary,
  QoeVerdict,
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

type SessionRef = Pick<
  LiveSession,
  | 'sessionId'
  | 'userId'
  | 'mediaFileId'
  | 'mediaTitle'
  | 'startedAt'
  | 'lastBeat'
  | 'deviceLabel'
  | 'systemName'
  | 'appVersion'
  | 'kind'
  | 'quality'
  | 'transcodeReasons'
  | 'state'
>;

type QoeEventRow = Pick<PlaybackQoeEvent, 'sessionId' | 'at' | 'type' | 'data'>;

interface Tracker {
  session: SessionRef;
  agg: QoeAggregator;
  pendingEvents: QoeEventRow[];
  eventCount: number;
  dirty: boolean;
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
  cmcd: boolean;
}

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

const clampInt = (n: number) => Math.min(Math.max(Math.round(n), 0), 2 ** 31 - 1);

const droppedPct = (dropped: number | null, decoded: number | null) =>
  dropped != null && decoded ? (dropped / decoded) * 100 : null;

@Injectable()
export class QoeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(QoeService.name);
  private readonly trackers = new Map<string, Tracker>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private enabledFlag = true;

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

  recordSample(session: SessionRef, sample: QoeSample): void {
    const t = this.track(session);
    if (!t) return;
    t.agg.addSample(sample, Date.now(), session.state !== 'paused');
  }

  recordEvents(session: SessionRef, events: QoeEvent[]): void {
    const t = this.track(session);
    if (!t) return;
    const now = Date.now();
    for (const e of events) {
      if (t.eventCount >= MAX_EVENTS_PER_SESSION) break;
      t.eventCount++;
      t.agg.addEvent(e, now);
      const { type, at, ...data } = e;
      t.pendingEvents.push({
        sessionId: session.sessionId,
        at: new Date(at),
        type,
        data,
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
      ...diagnose(s),
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
    };
  }

  /** The session left the registry: flush now. A stop is final, a GC may be revived. */
  sessionEnded(session: SessionRef, final: boolean): void {
    const t = this.trackers.get(session.sessionId);
    if (!t) return;
    t.endedAt = Date.now();
    t.dirty = true;
    void this.flush(t).then(() => {
      if (final) this.trackers.delete(session.sessionId);
    });
  }

  private track(session: SessionRef): Tracker | null {
    if (!this.enabledFlag) return null;
    let t = this.trackers.get(session.sessionId);
    if (!t) {
      t = {
        session,
        agg: new QoeAggregator(),
        pendingEvents: [],
        eventCount: 0,
        dirty: false,
        endedAt: null,
        touchedAt: 0,
        flushing: null,
        flushAgain: false,
      };
      this.trackers.set(session.sessionId, t);
    }
    t.session = session;
    t.endedAt = null;
    t.dirty = true;
    t.touchedAt = Date.now();
    return t;
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, t] of this.trackers) {
      if (t.dirty) await this.flush(t);
      if (now - t.touchedAt > TRACKER_IDLE_MS && !t.dirty) {
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
    if (!t.dirty) return Promise.resolve();
    t.dirty = false;
    const events = t.pendingEvents.splice(0);
    const run = async (): Promise<void> => {
      try {
        await this.sessions.upsert(this.toRow(t), ['sessionId']);
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

  private toRow(t: Tracker): PlaybackQoeSession {
    const s = t.agg.summary();
    const d = diagnose(s);
    const ses = t.session;
    return this.sessions.create({
      sessionId: ses.sessionId,
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
      playMethod: ses.kind,
      quality: ses.quality,
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
      verdict: d.verdict,
      confidence: d.confidence,
      reasons: d.reasons,
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

  async listSessions(q: QoeSessionQuery) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const qb = this.sessions
      .createQueryBuilder('s')
      .where('s."lastSeenAt" >= :since', { since: this.since(q.days ?? 7) })
      .orderBy('s."lastSeenAt"', 'DESC')
      .take(limit)
      .skip(Math.max(q.offset ?? 0, 0));
    if (q.verdict) qb.andWhere('s.verdict = :v', { v: q.verdict });
    if (q.userId != null) qb.andWhere('s."userId" = :u', { u: q.userId });
    if (q.device) qb.andWhere('s."deviceLabel" = :d', { d: q.device });
    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  async getSession(sessionId: string) {
    const row = await this.sessions.findOne({ where: { sessionId } });
    if (!row) return null;
    const events = await this.events.find({
      where: { sessionId },
      order: { at: 'ASC', id: 'ASC' },
    });
    return {
      ...row,
      events: events.map((e) => ({
        id: e.id,
        at: e.at,
        type: e.type,
        data: e.data,
      })),
    };
  }

  async summary(days = 7) {
    const rows = await this.sessions.find({
      select: [
        'deviceLabel',
        'engine',
        'verdict',
        'stallCount',
        'droppedFrames',
        'decodedFrames',
        'hwDecoder',
      ],
      where: { lastSeenAt: MoreThanOrEqual(this.since(days)) },
      take: MAX_SUMMARY_ROWS,
    });
    const byVerdict = Object.fromEntries(
      VERDICTS.map((v) => [v, 0]),
    ) as Record<QoeVerdict, number>;
    const groups = new Map<string, PlaybackQoeSession[]>();
    for (const r of rows) {
      byVerdict[r.verdict]++;
      const key = `${r.deviceLabel ?? ''}\u0000${r.engine ?? ''}`;
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }
    const byDevice: QoeDeviceSummary[] = [...groups.values()]
      .map((g) => {
        const pcts = g
          .map((r) => droppedPct(r.droppedFrames, r.decodedFrames))
          .filter((p): p is number => p != null);
        const hw = g.filter((r) => r.hwDecoder != null);
        const counts = new Map<QoeVerdict, number>();
        for (const r of g) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
        const top = [...counts].sort((a, b) => b[1] - a[1])[0][0];
        return {
          device: g[0].deviceLabel,
          engine: g[0].engine,
          sessions: g.length,
          stallSessions: g.filter((r) => r.stallCount > 0).length,
          avgDroppedPct: pcts.length
            ? pcts.reduce((a, b) => a + b, 0) / pcts.length
            : null,
          hwDecoderPct: hw.length
            ? (hw.filter((r) => r.hwDecoder).length / hw.length) * 100
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
