import { decideThrottle, isThrottleEligible, jobPlayheadSeconds } from './ffmpeg-throttle.service';

describe('decideThrottle', () => {
  it('pauses once ahead exceeds the threshold', () => {
    expect(decideThrottle({ aheadSeconds: 91, paused: false, thresholdSeconds: 90 })).toBe('pause');
    expect(decideThrottle({ aheadSeconds: 90, paused: false, thresholdSeconds: 90 })).toBe('noop');
  });

  it('resumes once ahead drops to half the threshold (hysteresis)', () => {
    expect(decideThrottle({ aheadSeconds: 46, paused: true, thresholdSeconds: 90 })).toBe('noop');
    expect(decideThrottle({ aheadSeconds: 45, paused: true, thresholdSeconds: 90 })).toBe('resume');
    expect(decideThrottle({ aheadSeconds: 0, paused: true, thresholdSeconds: 90 })).toBe('resume');
  });

  it('never re-pauses an already-paused run, and never re-resumes a running one', () => {
    expect(decideThrottle({ aheadSeconds: 200, paused: true, thresholdSeconds: 90 })).toBe('noop');
    expect(decideThrottle({ aheadSeconds: 10, paused: false, thresholdSeconds: 90 })).toBe('noop');
  });

  it("sits in the no-op band between resume-at-half and the pause threshold, a paused run stays paused, a running one keeps running", () => {
    expect(decideThrottle({ aheadSeconds: 60, paused: true, thresholdSeconds: 90 })).toBe('noop');
    expect(decideThrottle({ aheadSeconds: 60, paused: false, thresholdSeconds: 90 })).toBe('noop');
  });
});

describe('jobPlayheadSeconds (multi-viewer max)', () => {
  it('is null with no live session sharing the job', () => {
    expect(jobPlayheadSeconds([], 3, 24)).toBeNull();
  });

  it('throttles against the furthest-ahead viewer, not the slowest', () => {
    const live = [
      { position: 40, lastRequestedSegment: null },
      { position: 100, lastRequestedSegment: null },
    ];
    expect(jobPlayheadSeconds(live, 3, 24)).toBe(100);
  });

  it('takes the max of heartbeat position and the last requested segment start', () => {
    // segment 10 at 3s/segment starts at 30s, higher than the stale heartbeat.
    const live = [{ position: 5, lastRequestedSegment: 10 }];
    expect(jobPlayheadSeconds(live, 3, undefined)).toBe(30);
  });

  it('a buffering client with no heartbeat yet still counts its requested segment', () => {
    const live = [{ position: 0, lastRequestedSegment: 20 }];
    expect(jobPlayheadSeconds(live, 3, undefined)).toBe(60);
  });
});

describe('isThrottleEligible', () => {
  it('excludes the bounded early companion', () => {
    expect(isThrottleEligible('early', [])).toBe(false);
  });

  it('excludes a run backing any pinned (download) live session', () => {
    expect(isThrottleEligible('main', [{ pinned: true }])).toBe(false);
    expect(isThrottleEligible('remux', [{ pinned: false }, { pinned: true }])).toBe(false);
  });

  it('includes a plain main or remux run with no pinned viewer', () => {
    expect(isThrottleEligible('main', [{ pinned: false }])).toBe(true);
    expect(isThrottleEligible('remux', [])).toBe(true);
  });
});
