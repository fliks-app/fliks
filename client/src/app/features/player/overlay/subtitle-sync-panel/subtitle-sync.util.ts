import type { VttCue } from '../../../../core/services/playback-engine/subtitle-overlay.util';

/** Pixels of list per second of video: the single zoom knob of the panel. */
export const PX_PER_SEC = 20;
export const MIN_CUE_PX = 48;
const CUE_GAP_PX = 4;
/** Quiet time after the last user scroll event before the offset is committed. */
export const SETTLE_MS = 200;
export const KEY_STEP_SEC = 0.1;

/** Offset step of a key repeat after the key has been held `heldMs`: a single press stays fine. */
export const holdStep = (heldMs: number) => (heldMs < 500 ? KEY_STEP_SEC : heldMs < 1500 ? 0.25 : 0.5);

export const cueHeight = (c: VttCue, scale = PX_PER_SEC) => Math.max(MIN_CUE_PX, (c.end - c.start) * scale);

export interface CueBox {
  top: number;
  height: number;
}

/** Cue boxes at offset 0; a cue that would overlap the previous one is pushed below it. */
export function layoutCues(cues: readonly VttCue[], scale = PX_PER_SEC): CueBox[] {
  let bottom = -Infinity;
  return cues.map((c) => {
    const height = cueHeight(c, scale);
    const top = Math.max(c.start * scale, bottom + CUE_GAP_PX);
    bottom = top + height;
    return { top, height };
  });
}

/** Video time <-> list pixel, one monotonic map for the list at offset `base`: linear between cue starts (anchors),
 *  {@link PX_PER_SEC} outside; pushed-down cues stretch the list so the cue under the centre stays on time. */
export class TimeMap {
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly end: number;

  constructor(
    cues: readonly VttCue[],
    boxes: readonly CueBox[],
    readonly base: number,
    private readonly scale = PX_PER_SEC,
  ) {
    cues.forEach((c, i) => {
      const x = c.start + base;
      if (this.xs.length && x <= this.xs[this.xs.length - 1]) return;
      this.xs.push(x);
      this.ys.push(boxes[i].top + base * scale);
    });
    const last = boxes.length - 1;
    this.end = last < 0 ? 0 : boxes[last].top + boxes[last].height + base * scale;
  }

  px(time: number): number {
    return this.map(time, this.xs, this.ys, this.scale);
  }

  time(px: number): number {
    return this.map(px, this.ys, this.xs, 1 / this.scale);
  }

  /** Scrollable height: the video's end or the last cue, plus the half-viewport padding on each side. */
  height(duration: number, viewH: number): number {
    return Math.max(this.px(duration), this.end) + viewH;
  }

  private map(v: number, from: number[], to: number[], outside: number): number {
    const n = from.length;
    if (!n) return v * outside;
    if (v <= from[0]) return to[0] + (v - from[0]) * outside;
    if (v >= from[n - 1]) return to[n - 1] + (v - from[n - 1]) * outside;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (from[mid] <= v) lo = mid;
      else hi = mid;
    }
    return to[lo] + ((v - from[lo]) / (from[hi] - from[lo])) * (to[hi] - to[lo]);
  }
}

/** Offset making the cue under the centre line (list position `scrollTop`) start now. */
export const offsetFromScroll = (scrollTop: number, t: number, map: TimeMap) =>
  map.base + t - map.time(scrollTop);

export const boxTop = (b: CueBox, offset: number, viewH: number, scale = PX_PER_SEC) =>
  b.top + offset * scale + viewH / 2;

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
  boxes: readonly CueBox[],
  offset: number,
  scrollTop: number,
  viewH: number,
  scale = PX_PER_SEC,
): { cue: VttCue; box: CueBox; index: number }[] {
  const lo = scrollTop - viewH;
  const hi = scrollTop + 2 * viewH;
  const out: { cue: VttCue; box: CueBox; index: number }[] = [];
  cues.forEach((cue, index) => {
    const box = boxes[index];
    const top = boxTop(box, offset, viewH, scale);
    if (top <= hi && top + box.height >= lo) out.push({ cue, box, index });
  });
  return out;
}

export const TICK_SEC = 1;
export const LABEL_EVERY = 5;
export const RULER_PX = 48;
/** Room for `h:mm:ss` labels once the video reaches an hour. */
export const RULER_HOURS_PX = 64;
export const CHEVRON_PX = 20;

export interface Tick {
  time: number;
  top: number;
  label: string | null;
}

/** Ruler ticks (every {@link TICK_SEC}, labelled every {@link LABEL_EVERY}) in the window
 *  {@link visibleCues} uses; they sit at video time, so they ignore the offset. */
export function visibleTicks(map: TimeMap, scrollTop: number, viewH: number, duration: number): Tick[] {
  const from = Math.max(0, Math.ceil(map.time(scrollTop - viewH - viewH / 2) / TICK_SEC));
  const to = Math.min(Math.floor(duration / TICK_SEC), Math.floor(map.time(scrollTop + 2 * viewH - viewH / 2) / TICK_SEC));
  const out: Tick[] = [];
  for (let n = from; n <= to; n++) {
    const time = n * TICK_SEC;
    out.push({ time, top: map.px(time) + viewH / 2, label: n % LABEL_EVERY === 0 ? formatClock(time) : null });
  }
  return out;
}

/** `mm:ss`, or `h:mm:ss` from one hour. */
export function formatClock(t: number): string {
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Engines report time in bursts; this extrapolates between samples and eases into each new one. */
export class SmoothClock {
  private sample = NaN;
  private sampledAt = 0;
  private shown = 0;
  private last = 0;

  read(sample: number, nowMs: number, playing: boolean, rate = 1): number {
    if (sample !== this.sample) {
      this.sample = sample;
      this.sampledAt = nowMs;
    }
    const target = playing ? sample + Math.min(1, ((nowMs - this.sampledAt) / 1000) * rate) : sample;
    const dt = (nowMs - this.last) / 1000;
    this.last = nowMs;
    if (!playing || Math.abs(target - this.shown) > 0.5) this.shown = target;
    else this.shown += dt * rate + (target - this.shown) * 0.1;
    return this.shown;
  }
}

export function formatOffset(offset: number): string {
  return `${offset >= 0 ? '+' : '-'}${Math.abs(offset).toFixed(2)} s`;
}
