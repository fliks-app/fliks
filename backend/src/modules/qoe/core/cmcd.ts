import { fromCmcdHeaders, fromCmcdQuery } from '@svta/cml-cmcd';
import type { CmcdSnapshot } from './types';

type Req = {
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
};

function pick(raw: Record<string, unknown>): CmcdSnapshot | null {
  const out: CmcdSnapshot = {};
  for (const k of ['bl', 'mtp', 'br', 'tb'] as const) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  for (const k of ['bs', 'su'] as const) {
    if (raw[k] === true) out[k] = true;
  }
  if (raw.ot === 'v' || raw.ot === 'a' || raw.ot === 'av') out.ot = raw.ot;
  return Object.keys(out).length ? out : null;
}

/** CMCD off the `CMCD` query param, else the `CMCD-*` headers; null when absent or malformed. */
export function readCmcd(req: Req): CmcdSnapshot | null {
  try {
    const q = req.query?.['CMCD'];
    if (typeof q === 'string' && q) {
      return pick(fromCmcdQuery(`CMCD=${encodeURIComponent(q)}`));
    }
    const h = req.headers;
    if (
      h &&
      (h['cmcd-request'] ||
        h['cmcd-object'] ||
        h['cmcd-session'] ||
        h['cmcd-status'])
    ) {
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(h)) {
        if (k.startsWith('cmcd-') && v != null) {
          flat[k] = Array.isArray(v) ? v.join(',') : v;
        }
      }
      return pick(fromCmcdHeaders(flat));
    }
  } catch {
    // a malformed value from a client must never fail a segment request
  }
  return null;
}
