import type { LyricsCue, LyricsNote, StructuredLyrics } from '../api/lyrics.models';

export interface LaneNote {
  start: number;
  end: number;
  /** MIDI pitch, moved by octaves into the lane's range. */
  midi: number;
  golden: boolean;
  agentId?: string;
}

/** The MIDI rows the lane shows, `lo` and `hi` included. */
export interface LaneRange {
  lo: number;
  hi: number;
}

/** The song's range without its outliers (5th to 95th percentile), padded, at least an octave tall. */
export function laneRange(doc: StructuredLyrics): LaneRange {
  const p = (doc.cueLine ?? []).flatMap((l) => l.cue.flatMap((c) => cueNotes(c).map((n) => n.pitch))).sort((a, b) => a - b);
  if (!p.length) return { lo: 54, hi: 72 };
  let lo = Math.floor(p[Math.floor(p.length * 0.05)]) - 2;
  let hi = Math.ceil(p[Math.ceil(p.length * 0.95) - 1]) + 2;
  const short = 12 - (hi - lo);
  if (short > 0) {
    lo -= Math.floor(short / 2);
    hi += Math.ceil(short / 2);
  }
  return { lo, hi };
}

/** `midi` in the octave nearest `anchor`, then moved by octaves into the range: pitch trackers and singers miss by octaves. */
export function intoRange(midi: number, r: LaneRange, anchor = midi): number {
  let m = midi + 12 * Math.round((anchor - midi) / 12);
  while (m < r.lo) m += 12;
  while (m > r.hi) m -= 12;
  return m;
}

/** The notes sung on a cue: its `notes`, else its `pitch` over the whole cue. */
export function cueNotes(c: LyricsCue): LyricsNote[] {
  if (c.notes?.length) return c.notes;
  return c.pitch === undefined ? [] : [{ start: c.start, end: c.end, pitch: c.pitch }];
}

/** Notes whose span meets `[from, to]` (lyrics time, ms). */
export function laneNotes(doc: StructuredLyrics, from: number, to: number, range: LaneRange): LaneNote[] {
  const out: LaneNote[] = [];
  for (const l of doc.cueLine ?? []) {
    if (l.end < from || l.start > to) continue;
    for (const c of l.cue) {
      for (const n of cueNotes(c)) {
        if (n.end <= from || n.start >= to) continue;
        out.push({ start: n.start, end: n.end, midi: intoRange(n.pitch, range), golden: !!c.golden, agentId: l.agentId });
      }
    }
  }
  return out;
}
