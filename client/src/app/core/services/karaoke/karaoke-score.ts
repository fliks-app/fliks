import type { LyricsCue, StructuredLyrics } from '../api/lyrics.models';
import { cueNotes } from './pitch-lane';

export type Difficulty = 'easy' | 'medium' | 'hard';

/** Half-width of the hit window, in semitones, after the octave is folded away. */
export const TOLERANCE: Record<Difficulty, number> = { easy: 2, medium: 1.5, hard: 0.75 };
export const GOLDEN_WEIGHT = 2;
export const LINE_BONUS_RATIO = 0.9;
/** A score is out of this, as UltraStar shows it. */
export const MAX_SCORE = 10000;

/** One sung frame; `t` is host media time in ms, `midi` null when unvoiced. */
export interface PitchFrame {
  t: number;
  midi: number | null;
}

/** Distance in semitones between two notes, octave-insensitive (0..6). */
export function foldedDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 12;
  return Math.min(d, 12 - d);
}

export interface SingerScore {
  /** 0..MAX_SCORE */
  score: number;
  /** Points of lines sung to 90 %, folded into `score`. */
  lineBonus: number;
  lines: number[];
}

interface ScoredLine {
  cues: LyricsCue[];
}

/** Agents that sing: a duet has two or more of them, a background or group agent never takes a side. */
export function sides(doc: StructuredLyrics): string[] {
  return (doc.agents ?? []).filter((a) => a.role === 'main' || a.role === 'voice').map((a) => a.id);
}

/** A group line is sung by every side. */
function isSungBy(doc: StructuredLyrics, lineAgent: string | undefined, agentId: string): boolean {
  const id = lineAgent ?? sides(doc)[0];
  return id === agentId || doc.agents?.find((a) => a.id === id)?.role === 'group';
}

/** Pitched cues of a document that belong to `agentId` (every cue when it is null or the document has no agent on cues). */
export function scoredLines(doc: StructuredLyrics, agentId: string | null): ScoredLine[] {
  return (doc.cueLine ?? [])
    .filter((l) => agentId === null || isSungBy(doc, l.agentId, agentId))
    .map((l) => ({ cues: l.cue.filter((c) => c.pitch !== undefined && c.end > c.start) }))
    .filter((l) => l.cues.length > 0);
}

/**
 * Score against the reference melody. A note is worth its duration (golden twice): the share of its
 * span whose frames fall within the tolerance, `offsetMs` shifting the lyrics clock to the frames' one
 * and `latencyMs` removing the device's capture delay. 90 % of a line adds a bonus of 10 % of its worth.
 */
export function scoreSinger(
  lines: ScoredLine[],
  frames: readonly PitchFrame[],
  difficulty: Difficulty,
  offsetMs = 0,
  latencyMs = 0,
): SingerScore {
  const tol = TOLERANCE[difficulty];
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  const notes = lines.map((l) => l.cues.flatMap((c) => cueNotes(c).map((n) => ({ ...n, worth: (n.end - n.start) * (c.golden ? GOLDEN_WEIGHT : 1) }))));
  const spans = lines.map((l) => ({ lo: Math.min(...l.cues.map((c) => c.start)), hi: Math.max(...l.cues.map((c) => c.end)) }));
  const results = notes.map((line) => {
    let got = 0;
    let max = 0;
    for (const c of line) {
      const a = c.start - offsetMs;
      const b = c.end - offsetMs;
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid].t - latencyMs < a) lo = mid + 1;
        else hi = mid;
      }
      let hit = 0;
      let seen = 0;
      for (let i = lo; i < sorted.length && sorted[i].t - latencyMs < b; i++) {
        seen++;
        const m = sorted[i].midi;
        if (m !== null && foldedDistance(m, c.pitch) <= tol) hit++;
      }
      const w = c.worth;
      max += w;
      if (seen > 0) got += (w * hit) / seen;
    }
    return { got, max };
  });
  // One voice sings one line at a time: of lines that overlap, only the best-sung counts.
  const kept = new Set<number>();
  [...results.keys()]
    .sort((x, y) => results[y].got / (results[y].max || 1) - results[x].got / (results[x].max || 1))
    .forEach((i) => {
      if ([...kept].every((j) => !overlaps(spans[i], spans[j]))) kept.add(i);
    });
  let total = 0;
  let points = 0;
  let bonus = 0;
  results.forEach(({ got, max }, i) => {
    if (!kept.has(i)) return;
    total += max;
    points += got;
    if (max > 0 && got / max >= LINE_BONUS_RATIO) bonus += 0.1 * max;
  });
  if (total === 0) return { score: 0, lineBonus: 0, lines: lines.map(() => 0) };
  const cap = total * 1.1;
  return {
    score: Math.round((Math.min(points + bonus, cap) / cap) * MAX_SCORE),
    lineBonus: Math.round((bonus / cap) * MAX_SCORE),
    lines: results.map((r) => (r.max === 0 ? 0 : r.got / r.max)),
  };
}

/** Two lines overlap when they share more than half of the shorter one. */
function overlaps(a: { lo: number; hi: number }, b: { lo: number; hi: number }): boolean {
  return Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > 0.5 * Math.min(a.hi - a.lo, b.hi - b.lo);
}

/** Median offset between detected onsets and the cue starts they answer (ms), for the room calibration; null with fewer than 3 matches. */
export function estimateLatency(onsets: readonly number[], cueStarts: readonly number[], window = 800): number | null {
  const d: number[] = [];
  for (const o of onsets) {
    let best: number | null = null;
    for (const s of cueStarts) if (Math.abs(o - s) <= window && (best === null || Math.abs(o - s) < Math.abs(best))) best = o - s;
    if (best !== null) d.push(best);
  }
  if (d.length < 3) return null;
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
}
