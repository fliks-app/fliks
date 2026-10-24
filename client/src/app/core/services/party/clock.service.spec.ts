import { describe, expect, it } from 'vitest';
import { bestSample, ntpSample } from './clock.service';

describe('clock math', () => {
  it('computes offset and delay from the four timestamps', () => {
    // Server runs 1000 ms ahead, 40 ms each way.
    const s = ntpSample(0, 1040, 1041, 81);
    expect(s.offset).toBe(1000);
    expect(s.delay).toBe(80);
  });

  it('keeps the minimum-delay sample', () => {
    const best = bestSample([
      { offset: 10, delay: 90 },
      { offset: 3, delay: 20 },
      { offset: 7, delay: 50 },
    ]);
    expect(best).toEqual({ offset: 3, delay: 20 });
  });
});
