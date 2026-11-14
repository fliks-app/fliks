import type { StructuredLyrics } from '../api/lyrics.models';
import { estimateLatency, sides, scoreSinger, scoredLines, type Difficulty, type PitchFrame, type SingerScore } from './karaoke-score';

export const MAX_FRAMES = 20000;

/** Frames of one singer, kept sorted by time and bounded. */
export class FrameStore {
  private readonly byUser = new Map<number, PitchFrame[]>();

  add(userId: number, frames: readonly PitchFrame[]): void {
    const list = this.byUser.get(userId) ?? [];
    for (const f of frames) list.push(f);
    if (list.length > MAX_FRAMES) list.splice(0, list.length - MAX_FRAMES);
    this.byUser.set(userId, list);
  }

  frames(userId: number): readonly PitchFrame[] {
    return this.byUser.get(userId) ?? [];
  }

  /** Singers in the order their first frame arrived. */
  singers(): number[] {
    return [...this.byUser.keys()];
  }

  clear(): void {
    this.byUser.clear();
  }
}

export interface SingerResult extends SingerScore {
  userId: number;
  /** The duet side this singer takes, null when the song is solo or the singer sings every line. */
  agentId: string | null;
}

/** Each singer against the cues of their side (the n-th singer takes the n-th agent of a duet). */
export function scoreAll(
  doc: StructuredLyrics,
  store: FrameStore,
  difficulty: Difficulty,
  latencyMs: number,
  singers: readonly number[] = store.singers(),
): SingerResult[] {
  const agents = sides(doc);
  const duet = agents.length >= 2 && singers.length >= 2;
  return singers.map((userId, i) => {
    const agentId = duet ? (agents[i] ?? null) : null;
    return { userId, agentId, ...scoreSinger(scoredLines(doc, agentId), store.frames(userId), difficulty, doc.offset, latencyMs) };
  });
}

/** Onset times of a take: a voiced frame after at least 200 ms of silence. */
export function onsets(frames: readonly PitchFrame[]): number[] {
  const out: number[] = [];
  let lastVoiced = -Infinity;
  for (const f of frames) {
    if (f.midi === null) continue;
    if (f.t - lastVoiced > 200) out.push(f.t);
    lastVoiced = f.t;
  }
  return out;
}

/** Capture delay of a singer's device against the song's pitched cues; null when too few onsets match. */
export function calibrate(doc: StructuredLyrics, frames: readonly PitchFrame[]): number | null {
  const starts = scoredLines(doc, null).flatMap((l) => l.cues.map((c) => c.start - doc.offset));
  return estimateLatency(onsets(frames), starts);
}
