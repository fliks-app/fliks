export type EdlAction = 'cut' | 'mute' | 'commercial';
export interface EdlRange { start: number; end: number; action: EdlAction }
export interface TimeRange { start: number; end: number }

export const EOF_SLACK = 0.05;
export const COMMERCIAL_TAIL = 1;
export const MUTE_MERGE_GAP = 0.2;
/** A position this close to a range end is outside it (engines land a hair short). */
export const EDGE_EPS = 0.01;

/** Sorts and merges ranges whose gap is at most MUTE_MERGE_GAP; drops empty ones. */
export function mergeMuteRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start - last.end <= MUTE_MERGE_GAP) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

export function muteRangesOf(ranges: readonly EdlRange[]): TimeRange[] {
  return mergeMuteRanges(ranges.filter((r) => r.action === 'mute'));
}

/** `ranges` must be merged (see muteRangesOf). */
export function isMutedAt(ranges: readonly TimeRange[], t: number): boolean {
  return ranges.some((r) => r.start <= t && t < r.end);
}

/** The earliest range edge strictly after `t`, or null. */
export function nextMuteEdge(ranges: readonly TimeRange[], t: number): number | null {
  for (const r of ranges) {
    if (r.start > t) return r.start;
    if (r.end > t) return r.end;
  }
  return null;
}

export type EdlDecision =
  | { kind: 'none' }
  | { kind: 'seek'; to: number; action: 'cut' | 'commercial' }
  | { kind: 'end'; action: 'cut' | 'commercial' };

/** Skip policy with per-session state: a commercial is skipped once, then plays normally. */
export class EdlSkipPolicy {
  private ranges: EdlRange[] = [];
  /** Position of each commercial in the sorted commercial list; stable across timeline shifts. */
  private ordinals = new Map<EdlRange, number>();
  private readonly skipped = new Set<number>();
  private auto: boolean;

  /** `autoSkipCommercials` false: commercials are only skipped through skipCommercialAt(). */
  constructor(ranges: readonly EdlRange[], opts: { autoSkipCommercials?: boolean } = {}) {
    this.auto = opts.autoSkipCommercials !== false;
    this.setRanges(ranges);
  }

  setAutoSkipCommercials(on: boolean): void {
    this.auto = on;
  }

  /** New ranges for the same session: skipped commercials stay skipped while the count matches. */
  replaceRanges(ranges: readonly EdlRange[]): void {
    const before = this.ordinals.size;
    this.setRanges(ranges);
    if (this.ordinals.size !== before) this.skipped.clear();
  }

  resolve(t: number, duration: number): EdlDecision {
    return this.run(t, duration, null);
  }

  /** The unskipped commercial the playhead is in, outside its tail, or null. */
  commercialAt(t: number): { index: number; start: number; end: number } | null {
    const r = this.ranges.find((c) => this.skips(c, t, true) && c.action === 'commercial');
    return r ? { index: this.ordinals.get(r)!, start: r.start, end: r.end } : null;
  }

  /** Skips the commercial at `t`, then any cut or commercial chained at its end. */
  skipCommercialAt(t: number, duration: number): EdlDecision {
    const c = this.commercialAt(t);
    if (!c) return { kind: 'none' };
    this.skipped.add(c.index);
    return this.run(c.end, duration, 'commercial');
  }

  /** `chained`: the action already taken, which also forces commercials in manual mode. */
  private run(t: number, duration: number, chained: 'commercial' | null): EdlDecision {
    let pos = t;
    let first: 'cut' | 'commercial' | null = chained;
    for (let guard = 0; guard <= this.ranges.length; guard++) {
      const hit = this.ranges.find((r) => this.skips(r, pos, chained !== null));
      if (!hit) break;
      if (hit.action === 'commercial') this.skipped.add(this.ordinals.get(hit)!);
      first ??= hit.action as 'cut' | 'commercial';
      pos = hit.end;
    }
    if (first === null) return { kind: 'none' };
    if (duration > 0 && pos >= duration - EOF_SLACK) return { kind: 'end', action: first };
    return { kind: 'seek', to: pos, action: first };
  }

  /** The next position after `t` where resolve() may act, or null. */
  nextBoundary(t: number): number | null {
    let best: number | null = null;
    for (const r of this.ranges) {
      if (r.start <= t || this.done(r) || (!this.auto && r.action === 'commercial')) continue;
      if (best === null || r.start < best) best = r.start;
    }
    return best;
  }

  private done(r: EdlRange): boolean {
    return r.action === 'commercial' && this.skipped.has(this.ordinals.get(r)!);
  }

  private skips(r: EdlRange, t: number, force = false): boolean {
    if (!(r.start <= t && t < r.end - EDGE_EPS)) return false;
    if (r.action === 'cut') return true;
    return (this.auto || force) && !this.done(r) && t < r.end - COMMERCIAL_TAIL;
  }

  private setRanges(ranges: readonly EdlRange[]): void {
    this.ranges = ranges.filter((r) => r.action !== 'mute').sort((a, b) => a.start - b.start);
    this.ordinals = new Map();
    for (const r of this.ranges) if (r.action === 'commercial') this.ordinals.set(r, this.ordinals.size);
  }
}

/** Cast wire form: `d` = [gapMs, durationMs * 4 + actionCode, ...], each gap from the previous end. */
export interface EdlWire { v: 1; d: number[] }
const WIRE_ACTIONS: EdlAction[] = ['cut', 'mute', 'commercial'];

/** Keep the whole LOAD customData well under the 64 KB Cast message limit. */
export const CAST_CUSTOM_DATA_BUDGET = 48 * 1024;

/** `ranges` must be sorted and disjoint; bounds are rounded to the millisecond. */
export function encodeEdlWire(ranges: readonly EdlRange[]): EdlWire {
  const d: number[] = [];
  let prev = 0;
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const start = Math.max(Math.round(r.start * 1000), prev);
    const end = Math.max(Math.round(r.end * 1000), start);
    d.push(start - prev, (end - start) * 4 + WIRE_ACTIONS.indexOf(r.action));
    prev = end;
  }
  return { v: 1, d };
}

export function decodeEdlWire(wire: EdlWire): EdlRange[] {
  const out: EdlRange[] = [];
  let t = 0;
  for (let i = 0; i + 1 < wire.d.length; i += 2) {
    const start = t + wire.d[i];
    t = start + Math.floor(wire.d[i + 1] / 4);
    out.push({ start: start / 1000, end: t / 1000, action: WIRE_ACTIONS[wire.d[i + 1] % 4] });
  }
  return out;
}

export const jsonBytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;
