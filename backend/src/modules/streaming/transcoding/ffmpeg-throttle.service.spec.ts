import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  decideThrottle,
  isThrottleEligible,
  jobPlayheadSeconds,
  runLeadSeconds,
  FfmpegThrottleService,
} from './ffmpeg-throttle.service';
import { setPauseCapabilityForTest } from './ffmpeg-pause';

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

  it('converts a remux requested segment through the assembler grid, not the uniform formula', () => {
    // A keyframe grid (10s GOP) reports segment 4 starting at 35s; the uniform
    // formula (segmentDuration=6) would underestimate it as 24s.
    const live = [{ position: 0, lastRequestedSegment: 4 }];
    const remuxAssembler = { segmentContentSeconds: (i: number) => (i === 4 ? 35 : 0) };
    expect(jobPlayheadSeconds(live, 6, undefined, remuxAssembler)).toBe(35);
  });
});

describe('FfmpegThrottleService: tick re-entrancy', () => {
  it('drops an overlapping tick instead of running two at once', async () => {
    setPauseCapabilityForTest('signal');
    let resolveSettings!: () => void;
    const settings = {
      get: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveSettings = () =>
              resolve({ throttleEnabled: false, throttleThresholdSeconds: 90 });
          }),
      ),
    };
    const transcoding = { getActiveSessions: jest.fn().mockReturnValue([]) };
    const svc = new FfmpegThrottleService(transcoding as never, {} as never, settings as never);
    const tick = (svc as unknown as { tick(): Promise<void> }).tick.bind(svc);

    const first = tick();
    const second = tick();
    expect(settings.get).toHaveBeenCalledTimes(1);
    resolveSettings();
    await Promise.all([first, second]);
    expect(settings.get).toHaveBeenCalledTimes(1);
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

describe('runLeadSeconds', () => {
  const span = { startSeconds: 1650, frontierSeconds: 1800 };

  it('is the frontier minus a playhead inside the run', () => {
    expect(runLeadSeconds(span, 1700)).toBe(100);
    expect(runLeadSeconds(span, 1650)).toBe(150);
  });

  it('is zero for a playhead behind the run start (unreported resume, older cached output)', () => {
    expect(runLeadSeconds(span, 0)).toBe(0);
    expect(runLeadSeconds(span, 1600)).toBe(0);
  });
});

describe('FfmpegThrottleService: transcode run frontier', () => {
  const segmentDuration = 6;
  let dir: string;

  beforeEach(() => {
    setPauseCapabilityForTest('signal');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writeSegments = (from: number, to: number) => {
    for (let i = from; i <= to; i++) {
      fs.writeFileSync(path.join(dir, `seg-${String(i).padStart(4, '0')}.m4s`), '');
    }
  };

  const setup = (position: number) => {
    const kill = jest.fn();
    const session = {
      id: 'run',
      mediaFileId: 1,
      userId: 1,
      baseProfileHash: 'hash',
      variant: { kind: 'main' },
      cachePath: dir,
      startSegment: 275,
      segmentDuration,
      process: { exitCode: null, kill },
    };
    const svc = new FfmpegThrottleService(
      { getActiveSessions: () => [session] } as never,
      {
        listForJob: () => [{ position, lastRequestedSegment: null, pinned: false }],
      } as never,
      { get: () => Promise.resolve({ throttleEnabled: true, throttleThresholdSeconds: 90 }) } as never,
    );
    const tick = (svc as unknown as { tickOnce(): Promise<void> }).tickOnce.bind(svc);
    return { session, kill, tick };
  };

  it("ignores another process's segments past a gap before the run's first one", async () => {
    writeSegments(310, 360);
    const { session, kill, tick } = setup(275 * segmentDuration);
    await tick();
    expect(kill).not.toHaveBeenCalled();
    expect(session).not.toHaveProperty('throttlePaused', true);
  });

  it("measures the run's own unbroken output and pauses once it leads by the threshold", async () => {
    writeSegments(275, 280);
    const { session, kill, tick } = setup(275 * segmentDuration);
    await tick();
    expect(kill).not.toHaveBeenCalled();

    writeSegments(281, 300);
    await tick();
    expect(kill).toHaveBeenCalledWith('SIGSTOP');
    expect(session).toHaveProperty('throttlePaused', true);
    expect(session).toHaveProperty('throttleFrontierSegment', 301);
  });

  it('does not pause against a viewer that has not reported a position inside the run', async () => {
    writeSegments(275, 300);
    const { kill, tick } = setup(0);
    await tick();
    expect(kill).not.toHaveBeenCalled();
  });
});
