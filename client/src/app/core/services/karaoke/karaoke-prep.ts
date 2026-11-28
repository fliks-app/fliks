import type { KaraokeItemState, KaraokeStage } from '../api/karaoke.models';

export type SingKind = 'prepare' | 'queued' | 'running' | 'enter' | 'exit' | 'retry';

/** [start, width] in percent of the whole preparation: a lyrics sync costs several separations on the same device. */
const WEIGHTS: Record<KaraokeStage, [number, number]> = { separate: [0, 25], align: [25, 60], melody: [85, 15] };
/** The engine reports a stage at 95 % at most; the stage's end is the next event. */
const STAGE_CAP = 95;

/** Overall progress 0..100 from the running stage and its own progress. */
export function weightedProgress(stage: KaraokeStage | undefined, progress: number | undefined): number {
  const [start, width] = WEIGHTS[stage ?? 'separate'];
  return Math.round(start + (width * Math.min(STAGE_CAP, Math.max(0, progress ?? 0))) / STAGE_CAP);
}

/** Both stems exist: they play while the lyrics steps still run. */
export function stemsReady(state: KaraokeItemState | null): boolean {
  return !!state?.stems.instrumental && !!state.stems.vocals;
}

/** The Sing button's state for a track's karaoke job; null while the state is unknown. */
export function singKind(state: KaraokeItemState | null, entered: boolean): SingKind | null {
  if (stemsReady(state)) return entered ? 'exit' : 'enter';
  switch (state?.state) {
    case 'none':
    case 'ready':
      return 'prepare';
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'failed':
      return 'retry';
    default:
      return null;
  }
}
