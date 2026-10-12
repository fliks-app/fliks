import type { QoeDeviceSummary, QoeVerdict } from '../../core/services/api/qoe-api.service';

export interface DeviceRow {
  label: string;
  engine: string | null;
  /** The raw device labels this row covers, for filtering the sessions. */
  raw: string[];
  sessions: number;
  stallSessions: number;
  avgDroppedPct: number | null;
  hwDecoderPct: number | null;
  topVerdict: QoeVerdict;
}

/** Weighted by playbacks, over the rows that measured the value. */
function weighted(rows: QoeDeviceSummary[], pick: (r: QoeDeviceSummary) => number | null): number | null {
  const known = rows.filter((r) => pick(r) != null);
  const n = known.reduce((a, r) => a + r.sessions, 0);
  return n ? known.reduce((a, r) => a + pick(r)! * r.sessions, 0) / n : null;
}

/**
 * Merges the server's per-raw-label rows into the devices the admin recognises: a user agent changes with every
 * browser version, so one "Chrome on Linux" arrives as several rows.
 */
export function mergeDevices(rows: QoeDeviceSummary[], labelOf: (r: QoeDeviceSummary) => string): DeviceRow[] {
  const groups = new Map<string, QoeDeviceSummary[]>();
  for (const r of rows) {
    const key = `${labelOf(r)}\u0000${r.engine ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()]
    .map((g) => {
      const bySize = [...g].sort((a, b) => b.sessions - a.sessions);
      return {
        label: labelOf(g[0]),
        engine: g[0].engine,
        raw: g.map((r) => r.device).filter((d): d is string => !!d),
        sessions: g.reduce((a, r) => a + r.sessions, 0),
        stallSessions: g.reduce((a, r) => a + r.stallSessions, 0),
        avgDroppedPct: weighted(g, (r) => r.avgDroppedPct),
        hwDecoderPct: weighted(g, (r) => r.hwDecoderPct),
        topVerdict: (bySize.find((r) => r.topVerdict !== 'unknown') ?? bySize[0]).topVerdict,
      };
    })
    .sort((a, b) => b.sessions - a.sessions);
}
