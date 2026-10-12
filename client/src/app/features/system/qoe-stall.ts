import type { QoeEventRow, QoeStallCause } from '../../core/services/api/qoe-api.service';

export const QOE_CAUSES: readonly QoeStallCause[] = ['server', 'network', 'device', 'unknown'];

export const QOE_CAUSE_DOT_CLASS: Record<QoeStallCause, string> = {
  server: 'bg-error',
  network: 'bg-warning',
  device: 'bg-info',
  unknown: 'bg-base-content/30',
};

const mbps = (bps: number | undefined) => (bps == null ? '-' : (bps / 1_000_000).toFixed(1));

/** The translated line of a stall: the reason key and the evidence numbers it interpolates. */
export function stallExplanation(e: Pick<QoeEventRow, 'data'>): { key: string; params: Record<string, string> } | null {
  const d = e.data;
  if (!d?.cause || !d.causeReason) return null;
  const ev = d.causeEvidence ?? {};
  return {
    key: d.causeReason,
    params: {
      buffer: ev['bufferAheadS'] == null ? '-' : ev['bufferAheadS'].toFixed(1),
      throughput: mbps(ev['bandwidthBps']),
      bitrate: mbps(ev['variantBitrate']),
      wait: ev['waitedMs'] == null ? '-' : (ev['waitedMs'] / 1000).toFixed(1),
      speed: ev['transcodeSpeed'] == null ? '-' : ev['transcodeSpeed'].toFixed(1),
      dropped: ev['droppedPct'] == null ? '-' : ev['droppedPct'].toFixed(0),
    },
  };
}

export interface StallCauseTotal {
  cause: QoeStallCause;
  count: number;
  ms: number;
}

/** Count and total duration per cause over the classified stalls; empty when none was classified. */
export function stallBreakdown(events: Pick<QoeEventRow, 'type' | 'data'>[]): StallCauseTotal[] {
  const totals = new Map<QoeStallCause, StallCauseTotal>();
  for (const e of events) {
    const cause = e.type === 'stall' ? e.data?.cause : undefined;
    if (!cause) continue;
    const t = totals.get(cause) ?? { cause, count: 0, ms: 0 };
    t.count++;
    t.ms += e.data?.durationMs ?? 0;
    totals.set(cause, t);
  }
  return QOE_CAUSES.flatMap((c) => totals.get(c) ?? []);
}
