import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

// Wire contract: plan/playback-qoe.plan.md. Every backend shape the admin UI
// reads is mapped here, so a backend adjustment touches this file only.

export type QoeVerdict = 'ok' | 'network' | 'device' | 'server' | 'error' | 'unknown';
export type QoeEventType = 'stall' | 'error' | 'recovery' | 'quality_switch';

export interface QoeEvent {
  type: QoeEventType;
  /** Epoch ms, client clock. */
  at: number;
  position: number | null;
  durationMs?: number;
  bufferAheadS?: number | null;
  bandwidthBps?: number | null;
  code?: number;
  message?: string;
  category?: string;
  fromBitrate?: number;
  toBitrate?: number;
}

export interface QoeDiagnosis {
  verdict: QoeVerdict;
  confidence: 'high' | 'low';
  /** `qoe.reason.*` i18n keys, no params. */
  reasons: string[];
}

/** The `qoe` block of an `/api/system/streams` item. */
export interface StreamQoe extends QoeDiagnosis {
  stallCount: number;
  stallMs: number;
  droppedPct: number | null;
  bandwidthBps: number | null;
  variantBitrate: number | null;
  bufferAheadS: number | null;
  hwDecoder: boolean | null;
  decoderName: string | null;
  transcodeSpeed: number | null;
  engine: string | null;
  /** Server-parsed: CMCD actually received. */
  cmcd: boolean | null;
  /** The client declared CMCD. */
  cmcdClaimed?: boolean;
  playbackId?: string | null;
}

/** One playback: the merged fields of its sessions (a quality switch or recovery mints a new sid). */
export interface QoeSessionRow extends QoeDiagnosis {
  sessionId: string;
  playbackId: string | null;
  sessionIds: string[];
  userId: number | null;
  mediaFileId: number | null;
  mediaTitle: string | null;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  deviceLabel: string | null;
  systemName: string | null;
  appVersion: string | null;
  engine: string | null;
  cmcd: boolean | null;
  cmcdClaimed?: boolean;
  playMethod: 'transcode' | 'remux' | 'directplay' | 'live' | null;
  quality: string | null;
  transcodeReasons: string[] | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  decoderName: string | null;
  hwDecoder: boolean | null;
  watchedMs: number | null;
  stallCount: number;
  stallMs: number;
  droppedFrames: number | null;
  decodedFrames: number | null;
  avgBandwidthBps: number | null;
  minBandwidthBps: number | null;
  avgVariantBitrate: number | null;
  recoveryReloads: number;
  errorCount: number;
  medianTranscodeSpeed: number | null;
  /** Derived client-side for the shared badge. */
  droppedPct: number | null;
  bandwidthBps: number | null;
  variantBitrate: number | null;
  transcodeSpeed: number | null;
}

export interface QoeEventRow {
  id: number;
  sessionId?: string;
  at: string | number;
  type: QoeEventType;
  data: Partial<Omit<QoeEvent, 'type' | 'at'>> | null;
}

export interface QoeSessionDetail extends QoeSessionRow {
  /** Per-session breakdown, oldest first. */
  sessions: QoeSessionRow[];
  events: QoeEventRow[];
}

export interface QoeSessionPage {
  items: QoeSessionRow[];
  total: number;
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

export interface QoeSummary {
  byVerdict: Record<QoeVerdict, number>;
  byDevice: QoeDeviceSummary[];
}

export interface QoeSessionFilter {
  days: number;
  verdict?: QoeVerdict | '';
  userId?: number | null;
  device?: string;
  limit: number;
  offset: number;
}

export const QOE_SETTING_ENABLED = 'qoe_enabled';
export const QOE_SETTING_RETENTION_DAYS = 'qoe_retention_days';

type RawRow = Omit<
  QoeSessionRow,
  'droppedPct' | 'bandwidthBps' | 'variantBitrate' | 'transcodeSpeed' | 'playbackId' | 'sessionIds'
> & { playbackId?: string | null; sessionIds?: string[] };

function normalizeRow(row: RawRow): QoeSessionRow {
  const decoded = row.decodedFrames ?? 0;
  return {
    ...row,
    playbackId: row.playbackId ?? null,
    sessionIds: row.sessionIds ?? [row.sessionId],
    droppedPct: row.droppedFrames != null && decoded > 0 ? (row.droppedFrames / decoded) * 100 : null,
    bandwidthBps: row.avgBandwidthBps,
    variantBitrate: row.avgVariantBitrate,
    transcodeSpeed: row.medianTranscodeSpeed,
  };
}

@Injectable({ providedIn: 'root' })
export class QoeApiService {
  private readonly http = inject(HttpClient);

  async summary(days: number): Promise<QoeSummary> {
    return firstValueFrom(
      this.http.get<QoeSummary>('/api/system/qoe/summary', { params: { days } }),
    );
  }

  async sessions(filter: QoeSessionFilter): Promise<QoeSessionPage> {
    let params = new HttpParams()
      .set('days', filter.days)
      .set('limit', filter.limit)
      .set('offset', filter.offset);
    if (filter.verdict) params = params.set('verdict', filter.verdict);
    if (filter.userId) params = params.set('userId', filter.userId);
    if (filter.device) params = params.set('device', filter.device);
    const res = await firstValueFrom(
      this.http.get<{ items: RawRow[]; total: number }>('/api/system/qoe/sessions', { params }),
    );
    return { total: res.total, items: res.items.map(normalizeRow) };
  }

  /** `id` is a sessionId or a playbackId. */
  async session(id: string): Promise<QoeSessionDetail> {
    const res = await firstValueFrom(
      this.http.get<RawRow & { sessions?: RawRow[]; events?: QoeEventRow[] }>(
        `/api/system/qoe/sessions/${encodeURIComponent(id)}`,
      ),
    );
    return {
      ...normalizeRow(res),
      sessions: (res.sessions ?? []).map(normalizeRow),
      events: res.events ?? [],
    };
  }
}
