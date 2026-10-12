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

export interface QoeReason {
  /** `qoe.reason.*` i18n key. */
  key: string;
  params?: Record<string, string | number>;
}

export interface QoeDiagnosis {
  verdict: QoeVerdict;
  confidence: 'high' | 'low';
  reasons: QoeReason[];
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
  cmcd: boolean | null;
}

export interface QoeSessionRow extends QoeDiagnosis {
  sessionId: string;
  userId: number | null;
  username: string | null;
  device: string | null;
  engine: string | null;
  mediaTitle: string | null;
  startedAt: string;
  watchedS: number | null;
  stallCount: number;
  stallMs: number;
  droppedPct: number | null;
  hwDecoder: boolean | null;
  decoderName: string | null;
  bandwidthBps: number | null;
  variantBitrate: number | null;
  cmcd: boolean | null;
}

export interface QoeSessionDetail extends QoeSessionRow {
  events: QoeEvent[];
}

export interface QoeSessionPage {
  items: QoeSessionRow[];
  total: number;
}

export interface QoeDeviceSummary {
  device: string;
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

/** Backend may send a bare i18n key or `{ key, params }`. */
export function normalizeReasons(raw: unknown): QoeReason[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => (typeof r === 'string' ? { key: r } : (r as QoeReason)));
}

function normalizeRow<T extends { reasons?: unknown }>(row: T): T & { reasons: QoeReason[] } {
  return { ...row, reasons: normalizeReasons(row.reasons) };
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
      this.http.get<QoeSessionPage | QoeSessionRow[]>('/api/system/qoe/sessions', { params }),
    );
    const page = Array.isArray(res) ? { items: res, total: res.length } : res;
    return { total: page.total, items: page.items.map(normalizeRow) };
  }

  async session(sessionId: string): Promise<QoeSessionDetail> {
    const res = await firstValueFrom(
      this.http.get<QoeSessionDetail>(`/api/system/qoe/sessions/${encodeURIComponent(sessionId)}`),
    );
    return { ...normalizeRow(res), events: res.events ?? [] };
  }
}
