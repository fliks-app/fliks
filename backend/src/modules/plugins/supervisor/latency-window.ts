const CAPACITY = 256;

/**
 * Fixed-size ring of recent durations. `p95()` is over the last CAPACITY samples, not a time
 * window — a plugin runs for weeks, so an unbounded array is never an option.
 */
export class LatencyWindow {
  private samples: number[] = [];
  private next = 0;

  push(ms: number): void {
    if (this.samples.length < CAPACITY) {
      this.samples.push(ms);
    } else {
      this.samples[this.next] = ms;
      this.next = (this.next + 1) % CAPACITY;
    }
  }

  get size(): number {
    return this.samples.length;
  }

  /** Null with no samples yet. Nearest-rank over the current window, rounded to 0.1 ms because
   *  `performance.now()` resolves finer than any consumer of this number cares about. */
  p95(): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const rank = Math.min(Math.ceil(0.95 * sorted.length) - 1, sorted.length - 1);
    return Math.round(sorted[Math.max(0, rank)] * 10) / 10;
  }
}
