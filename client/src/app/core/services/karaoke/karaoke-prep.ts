import type { KaraokeItemState, KaraokeStage } from '../api/karaoke.models';

export type SingKind = 'prepare' | 'queued' | 'running' | 'enter' | 'exit' | 'retry';

/** Share of the whole preparation each stage covers, as estimates: [start, width] in percent. */
const WEIGHTS: Record<KaraokeStage, [number, number]> = { separate: [0, 70], align: [70, 20], melody: [90, 10] };

/** Overall progress 0..100 from the running stage and its own 0..100 progress. */
export function weightedProgress(stage: KaraokeStage | undefined, progress: number | undefined): number {
  const [start, width] = WEIGHTS[stage ?? 'separate'];
  return Math.round(start + (width * Math.min(100, Math.max(0, progress ?? 0))) / 100);
}

/** The Sing button's state for a track's karaoke job; null while the state is unknown. */
export function singKind(state: KaraokeItemState | null, entered: boolean): SingKind | null {
  switch (state?.state) {
    case 'none':
      return 'prepare';
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'failed':
      return 'retry';
    case 'ready':
      return entered ? 'exit' : 'enter';
    default:
      return null;
  }
}
