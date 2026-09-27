import { remuxProduced, remuxReachable, remuxWaitWindow } from './remux-reachability';

describe('remuxReachable (live run: wait vs respawn)', () => {
  it('is false below the run\'s own start: it will never produce a segment behind it', () => {
    expect(remuxReachable({ requestedSegment: 5, start: 10, frontier: 12, waitWindow: 3 })).toBe(false);
  });

  it('is true for a segment already produced (below the frontier)', () => {
    expect(remuxReachable({ requestedSegment: 11, start: 10, frontier: 20, waitWindow: 3 })).toBe(true);
  });

  it('is true just past the frontier, within the wait window', () => {
    expect(remuxReachable({ requestedSegment: 22, start: 10, frontier: 20, waitWindow: 3 })).toBe(true);
  });

  it('is false far past the frontier, beyond the wait window (a real seek, not a buffer-ahead)', () => {
    expect(remuxReachable({ requestedSegment: 65, start: 0, frontier: 5, waitWindow: 3 })).toBe(false);
  });

  it('unopened run (no frontier yet): reachable only within the wait window of its own start', () => {
    expect(remuxReachable({ requestedSegment: 2, start: 0, frontier: null, waitWindow: 3 })).toBe(true);
    expect(remuxReachable({ requestedSegment: 9, start: 0, frontier: null, waitWindow: 3 })).toBe(false);
  });
});

describe('remuxProduced (exited run: hard boundary, no buffer-ahead)', () => {
  it('is true inside [start, frontier)', () => {
    expect(remuxProduced({ requestedSegment: 12, start: 10, frontier: 15 })).toBe(true);
  });

  it('is false at/after the frontier: an exited run never produces anything more', () => {
    expect(remuxProduced({ requestedSegment: 15, start: 10, frontier: 15 })).toBe(false);
  });

  it('is false below start even when an unrelated island sits on disk at that number', () => {
    // A killed run's leftover seg-9 is not this run's output: it only covers [10, 15).
    expect(remuxProduced({ requestedSegment: 9, start: 10, frontier: 15 })).toBe(false);
  });

  it('is false with no frontier at all (run never opened)', () => {
    expect(remuxProduced({ requestedSegment: 10, start: 10, frontier: null })).toBe(false);
  });
});

describe('remuxWaitWindow (buffer-ahead sized to measured throughput, capped)', () => {
  it('falls back to the cap with no measured throughput yet', () => {
    expect(remuxWaitWindow({ segmentsPerSecond: null, bufferSeconds: 3, capSegments: 3 })).toBe(3);
  });

  it('is capped even for a fast run', () => {
    expect(remuxWaitWindow({ segmentsPerSecond: 10, bufferSeconds: 3, capSegments: 3 })).toBe(3);
  });

  it('shrinks for a slow run, never below 1', () => {
    expect(remuxWaitWindow({ segmentsPerSecond: 0.05, bufferSeconds: 3, capSegments: 3 })).toBe(1);
  });
});
