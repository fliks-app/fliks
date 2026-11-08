import type { StructuredLyrics } from '../api/lyrics.models';

export interface LaneNote {
  start: number;
  end: number;
  /** Pitch class 0..12 (octave folded, fractional). */
  fold: number;
  golden: boolean;
  agentId?: string;
}

export const foldPitch = (midi: number): number => ((midi % 12) + 12) % 12;

/** Pitched cues whose span meets `[from, to]` (lyrics time, ms). */
export function laneNotes(doc: StructuredLyrics, from: number, to: number): LaneNote[] {
  const out: LaneNote[] = [];
  for (const l of doc.cueLine ?? []) {
    if (l.end < from || l.start > to) continue;
    for (const c of l.cue) {
      if (c.pitch === undefined || c.end <= from || c.start >= to) continue;
      out.push({ start: c.start, end: c.end, fold: foldPitch(c.pitch), golden: !!c.golden, agentId: l.agentId });
    }
  }
  return out;
}
