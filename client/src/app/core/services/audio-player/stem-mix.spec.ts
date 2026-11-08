import { DRIFT_TOLERANCE_S, GUIDE_VOCAL_LEVEL, mixGains, needsReseek } from './stem-mix';

describe('stem-mix', () => {
  it('plays the main element until the stems are loaded', () => {
    expect(mixGains('instrumental', 0, false)).toEqual({ main: 1, instrumental: 0, vocals: 0 });
    expect(mixGains('original', 1, true)).toEqual({ main: 1, instrumental: 0, vocals: 0 });
  });

  it('mutes the main element and mixes the vocals by level', () => {
    expect(mixGains('instrumental', 0, true)).toEqual({ main: 0, instrumental: 1, vocals: 0 });
    expect(mixGains('guide', GUIDE_VOCAL_LEVEL, true).vocals).toBe(GUIDE_VOCAL_LEVEL);
    expect(mixGains('guide', 3, true).vocals).toBe(1);
  });

  it('reseeks only past the drift tolerance', () => {
    expect(needsReseek(10, 10 + DRIFT_TOLERANCE_S - 0.01)).toBe(false);
    expect(needsReseek(10, 10 - DRIFT_TOLERANCE_S - 0.01)).toBe(true);
  });
});
