import type { QoeDiagnosis, QoeVerdict } from '../../core/services/api/qoe-api.service';
import type { Fmt } from './qoe-stall';

export const QOE_VERDICTS: readonly QoeVerdict[] = ['ok', 'network', 'device', 'server', 'error', 'unknown'];

export const QOE_VERDICT_BAR_CLASS: Record<QoeVerdict, string> = {
  ok: 'bg-success',
  network: 'bg-warning',
  device: 'bg-info',
  server: 'bg-error',
  error: 'bg-error',
  unknown: 'bg-base-content/30',
};

/** The dot follows the verdict alone, so it never disagrees with the verdict label next to it. */
export function qoeDotClass(q: Pick<QoeDiagnosis, 'verdict'>): string {
  return QOE_VERDICT_BAR_CLASS[q.verdict];
}

/** "5,5 Mbps" in the admin's language; empty when unknown, so callers can drop the value. */
export function formatMbps(bps: number | null | undefined, f: Fmt): string {
  return bps == null ? '' : f.t('qoe.mbps', { value: f.n(bps / 1_000_000, 1) });
}
