import type { VttCue } from '../../../../core/services/playback-engine/subtitle-overlay.util';

/** Pixels of list per second of video: the single zoom knob of the panel. */
export const PX_PER_SEC = 60;
export const MIN_CUE_PX = 28;
/** Quiet time after the last user scroll event before the offset is committed. */
export const SETTLE_MS = 200;
export const KEY_STEP_SEC = 0.1;

/** Content is padded by half a viewport so both ends of the video reach the centre line. */
export const contentHeight = (duration: number, viewH: number, scale = PX_PER_SEC) => duration * scale + viewH;

export const cueTop = (c: VttCue, offset: number, viewH: number, scale = PX_PER_SEC) =>
  (c.start + offset) * scale + viewH / 2;

export const cueHeight = (c: VttCue, scale = PX_PER_SEC) => Math.max(MIN_CUE_PX, (c.end - c.start) * scale);

/** scrollTop that puts the centre line on video time `t`. */
export const scrollTopForTime = (t: number, scale = PX_PER_SEC) => t * scale;

/** Offset making the cue under the centre line (list position `scrollTop`) start now, given the
 *  offset `base` the list was laid out with. */
export const offsetFromScroll = (scrollTop: number, t: number, base: number, scale = PX_PER_SEC) =>
  base + t - scrollTop / scale;

/** A scroll event is the user's unless a gesture is on or it moved off what we last wrote. */
export const isUserScroll = (scrollTop: number, lastWritten: number, interacting: boolean) =>
  interacting || Math.abs(scrollTop - lastWritten) > 1;

/** Indexes of the cues active at `t` once shifted by `offset`. */
export function activeCues(cues: readonly VttCue[], t: number, offset: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < cues.length && cues[i].start + offset <= t; i++) {
    if (t < cues[i].end + offset) out.push(i);
  }
  return out;
}

/** Cues overlapping one viewport above and below the one at `scrollTop`. */
export function visibleCues(
  cues: readonly VttCue[],
  offset: number,
  scrollTop: number,
  viewH: number,
  scale = PX_PER_SEC,
): { cue: VttCue; index: number }[] {
  const lo = scrollTop - viewH;
  const hi = scrollTop + 2 * viewH;
  const out: { cue: VttCue; index: number }[] = [];
  cues.forEach((cue, index) => {
    const top = cueTop(cue, offset, viewH, scale);
    if (top <= hi && top + cueHeight(cue, scale) >= lo) out.push({ cue, index });
  });
  return out;
}

export function formatOffset(offset: number): string {
  return `${offset >= 0 ? '+' : '-'}${Math.abs(offset).toFixed(2)} s`;
}
