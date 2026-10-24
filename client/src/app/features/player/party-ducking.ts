export const DUCK_FACTOR = 0.4;
const RAMP_MS = 250;
const STEP_MS = 25;

export interface DuckEngine {
  volume: number;
  readonly supportsVolume: boolean;
}

/** Ramps the engine volume down to a fraction of the user's level while `active`, and back up after.
 *  `onWrite` is told each level before it is written, so the user's saved level stays untouched. */
export class VoiceDucker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private level: number | null = null;

  constructor(
    private readonly engine: () => DuckEngine | null,
    private readonly base: () => number,
    private readonly onWrite: (level: number) => void,
  ) {}

  set(active: boolean): void {
    const e = this.engine();
    if (!e?.supportsVolume) return;
    const target = active ? this.base() * DUCK_FACTOR : this.base();
    if (this.level === null && !active) return;
    const from = this.level ?? this.base();
    const step = ((target - from) * STEP_MS) / RAMP_MS;
    if (this.timer) clearInterval(this.timer);
    const tick = () => {
      const eng = this.engine();
      const next = this.level ?? from;
      const done = !eng || Math.abs(target - next) <= Math.abs(step);
      const v = done ? target : next + step;
      this.level = active || !done ? v : null;
      if (eng) {
        this.onWrite(v);
        eng.volume = v;
      }
      if (done && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
    this.timer = setInterval(tick, STEP_MS);
    tick();
  }

  /** Puts the user's level back at once (leaving the party, engine teardown). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.level === null) return;
    const e = this.engine();
    if (e) {
      this.onWrite(this.base());
      e.volume = this.base();
    }
    this.level = null;
  }
}
