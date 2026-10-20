/** A one-shot timer that pauses and resumes without losing its remaining time; backs the floating cues'
 *  auto-retract, frozen while the controls bar is up. */
export class PausableTimeout {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private remainingMs = 0;
  private resumedAt = 0;

  constructor(private readonly onElapsed: () => void) {}

  /** (Re)start from a full duration, discarding any prior run. */
  start(durationMs: number): void {
    this.cancel();
    this.remainingMs = durationMs;
    this.run();
  }

  /** Freeze the countdown, banking the time left. No-op unless running. */
  pause(): void {
    if (this.handle === null) return;
    clearTimeout(this.handle);
    this.handle = null;
    this.remainingMs -= Date.now() - this.resumedAt;
  }

  /** Resume a paused countdown from where it stopped. No-op unless paused. */
  resume(): void {
    if (this.handle !== null || this.remainingMs <= 0) return;
    this.run();
  }

  /** Stop and forget — the cue is gone for good. */
  cancel(): void {
    if (this.handle !== null) clearTimeout(this.handle);
    this.handle = null;
    this.remainingMs = 0;
  }

  private run(): void {
    this.resumedAt = Date.now();
    this.handle = setTimeout(() => {
      this.handle = null;
      this.remainingMs = 0;
      this.onElapsed();
    }, this.remainingMs);
  }
}
