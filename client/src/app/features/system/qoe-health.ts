import type { QoeDiagnosis, QoeVerdict } from '../../core/services/api/qoe-api.service';

export type QoeHealth = 'ok' | 'warn' | 'bad' | 'unknown';

/** Dot colour: unknown grey, ok green (orange once stalls or low confidence), a fault red (orange when unsure). */
export function qoeHealth(q: QoeDiagnosis & { stallCount?: number }): QoeHealth {
  if (q.verdict === 'unknown') return 'unknown';
  if (q.verdict === 'ok') return q.confidence === 'low' || (q.stallCount ?? 0) > 0 ? 'warn' : 'ok';
  return q.confidence === 'low' ? 'warn' : 'bad';
}

export const QOE_DOT_CLASS: Record<QoeHealth, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-error',
  unknown: 'bg-base-content/30',
};

export const QOE_VERDICTS: readonly QoeVerdict[] = ['ok', 'network', 'device', 'server', 'error', 'unknown'];

export const QOE_VERDICT_BAR_CLASS: Record<QoeVerdict, string> = {
  ok: 'bg-success',
  network: 'bg-warning',
  device: 'bg-info',
  server: 'bg-error',
  error: 'bg-error',
  unknown: 'bg-base-content/30',
};

export function formatMbps(bps: number | null | undefined): string {
  return bps == null ? '-' : `${(bps / 1_000_000).toFixed(1)} Mbps`;
}
