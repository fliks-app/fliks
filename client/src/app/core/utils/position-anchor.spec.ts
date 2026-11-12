import { describe, expect, it } from 'vitest';
import { projectPosition } from './position-anchor';

describe('projectPosition', () => {
  it('moves at the playback rate and holds while paused', () => {
    const a = { position: 10, at: 0, playing: true, duration: 100 };
    expect(projectPosition(a, 4000)).toBe(14);
    expect(projectPosition({ ...a, rate: 1.5 }, 4000)).toBe(16);
    expect(projectPosition({ ...a, playing: false, rate: 2 }, 4000)).toBe(10);
  });
});
