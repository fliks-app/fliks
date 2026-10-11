import { isMutedAt, mergeMuteRanges, nextMuteEdge, type TimeRange } from '../../utils/edl-policy';

export interface MuteGateOptions {
  /** Current content position in seconds. */
  position: () => number;
  rate: () => number;
  paused: () => boolean;
  /** Called only when the gate state changes. */
  apply: (muted: boolean) => void;
  /** Mutes from `start - leadS` to cover the output latency. */
  leadS?: number;
  /** Stays muted until `end + trailS`; 0 unmutes exactly at the range end. */
  trailS?: number;
}

const DEFAULT_LEAD_S = 0.03;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Silences a range list on top of the user's own mute; the caller decides what `apply` touches. */
export class MuteGate {
  private ranges: TimeRange[] = [];
  private muted = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly lead: number;
  private readonly trail: number;

  constructor(private readonly opts: MuteGateOptions) {
    this.lead = opts.leadS ?? DEFAULT_LEAD_S;
    this.trail = opts.trailS ?? 0;
  }

  setRanges(ranges: readonly TimeRange[]): void {
    this.ranges = mergeMuteRanges(
      mergeMuteRanges(ranges).map((r) => ({ start: Math.max(0, r.start - this.lead), end: r.end + this.trail })),
    );
    this.sync();
  }

  /** Re-evaluates at `seekTarget` (a position the clock has not reached yet) or the live position. */
  sync(seekTarget?: number): void {
    this.clearTimer();
    const raw = seekTarget ?? this.opts.position();
    const pos = Number.isFinite(raw) ? raw : 0;
    const playing = !this.opts.paused();
    this.set(isMutedAt(this.ranges, pos));
    const rate = this.opts.rate();
    if (!playing || !(rate > 0)) return;
    const edge = nextMuteEdge(this.ranges, pos);
    if (edge === null) return;
    const ms = Math.min(Math.max(((edge - pos) / rate) * 1000, 1), MAX_TIMER_MS);
    this.timer = setTimeout(() => this.sync(), ms);
  }

  dispose(): void {
    this.clearTimer();
    this.ranges = [];
    this.set(false);
  }

  private set(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    this.opts.apply(muted);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
