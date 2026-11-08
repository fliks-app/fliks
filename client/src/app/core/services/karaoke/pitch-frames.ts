import type { PitchFrame } from './karaoke-score';

/** Data channel label of the pitch frames inside a party. */
export const PITCH_CHANNEL = 'karaoke-pitch';
export const MAX_FRAMES_PER_BATCH = 50;

/** Wire batch: frame times in host media ms, notes in tenths of a semitone (-1 unvoiced). Never audio. */
export interface PitchBatch {
  k: 'pf';
  t: number[];
  m: number[];
}

export function encodeBatch(frames: readonly PitchFrame[]): string {
  const f = frames.slice(0, MAX_FRAMES_PER_BATCH);
  const batch: PitchBatch = {
    k: 'pf',
    t: f.map((x) => Math.round(x.t)),
    m: f.map((x) => (x.midi === null ? -1 : Math.round(x.midi * 10))),
  };
  return JSON.stringify(batch);
}

/** Frames of a peer's message; anything malformed is dropped, a peer is not trusted. */
export function decodeBatch(data: unknown): PitchFrame[] {
  if (typeof data !== 'string' || data.length > 4096) return [];
  let b: Partial<PitchBatch>;
  try {
    b = JSON.parse(data) as Partial<PitchBatch>;
  } catch {
    return [];
  }
  if (b.k !== 'pf' || !Array.isArray(b.t) || !Array.isArray(b.m) || b.t.length !== b.m.length) return [];
  const out: PitchFrame[] = [];
  for (let i = 0; i < Math.min(b.t.length, MAX_FRAMES_PER_BATCH); i++) {
    const t = b.t[i];
    const m = b.m[i];
    if (!Number.isFinite(t) || !Number.isFinite(m) || t < 0) continue;
    out.push({ t, midi: m < 0 ? null : m / 10 });
  }
  return out;
}
