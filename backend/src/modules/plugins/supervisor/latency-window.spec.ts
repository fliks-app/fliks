import { LatencyWindow } from './latency-window';

describe('LatencyWindow', () => {
  it('p95 over a known set of samples is the nearest-rank value', () => {
    const w = new LatencyWindow();
    // 1..100ms: rank = ceil(0.95*100)-1 = 94 (0-indexed) -> value 95.
    for (let ms = 1; ms <= 100; ms++) w.push(ms);
    expect(w.p95()).toBe(95);
  });

  it('is null with no samples yet', () => {
    expect(new LatencyWindow().p95()).toBeNull();
  });

  it('does not grow past its fixed capacity', () => {
    const w = new LatencyWindow();
    for (let i = 0; i < 10_000; i++) w.push(i);
    expect(w.size).toBe(256);
  });

  it('overwrites the oldest sample once at capacity, so p95 tracks only the recent window', () => {
    const w = new LatencyWindow();
    for (let i = 0; i < 256; i++) w.push(1); // fill with a low value
    expect(w.p95()).toBe(1);
    for (let i = 0; i < 256; i++) w.push(1000); // fully overwrite with a high one
    expect(w.p95()).toBe(1000);
    expect(w.size).toBe(256);
  });

  it('rounds to a tenth of a millisecond, so a sub-microsecond clock does not reach the UI', () => {
    const w = new LatencyWindow();
    w.push(295.8883610000048);
    expect(w.p95()).toBe(295.9);
  });
});
