import { describe, expect, it } from 'vitest';
import { LatestWins } from './latest-wins';

describe('LatestWins', () => {
  it('keeps only the newest token current', () => {
    const w = new LatestWins();
    const a = w.begin();
    expect(w.isCurrent(a)).toBe(true);
    const b = w.begin();
    expect(w.isCurrent(a)).toBe(false);
    expect(w.isCurrent(b)).toBe(true);
  });

  it('outdates every token on cancel', () => {
    const w = new LatestWins();
    const a = w.begin();
    w.cancel();
    expect(w.isCurrent(a)).toBe(false);
  });
});
