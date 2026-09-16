import { describe, expect, it, vi, afterEach } from 'vitest';
import { programmeProgressPercent } from './programme-progress';

function programme(startMinutesAgo: number, durationMinutes: number) {
  const start = Date.now() - startMinutesAgo * 60_000;
  return {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + durationMinutes * 60_000).toISOString(),
  } as never;
}

describe('programmeProgressPercent', () => {
  afterEach(() => vi.useRealTimers());

  it('is zero without a programme', () => {
    expect(programmeProgressPercent(null)).toBe(0);
    expect(programmeProgressPercent(undefined)).toBe(0);
  });

  it('reports how far the broadcast has run', () => {
    expect(programmeProgressPercent(programme(15, 60))).toBeCloseTo(25, 0);
  });

  it('clamps a programme that has already ended', () => {
    expect(programmeProgressPercent(programme(90, 60))).toBe(100);
  });

  it('clamps one that has not started', () => {
    expect(programmeProgressPercent(programme(-10, 60))).toBe(0);
  });

  it('refuses a zero or negative span rather than dividing by it', () => {
    const start = new Date().toISOString();
    expect(programmeProgressPercent({ startsAt: start, endsAt: start } as never)).toBe(0);
  });
});
