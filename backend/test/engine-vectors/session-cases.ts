import { mulberry32 } from './fuzz';
import type {
  SessionKind,
  SessionMatrix,
  SessionVector,
} from './session-vectors';

type Rng = () => number;
type Obj = Record<string, any>;

const rint = (r: Rng, lo: number, hi: number) =>
  lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rng, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)];
const chance = (r: Rng, p: number) => r() < p;
const range = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

/** A fixed instant, whole seconds: file mtimes round-trip exactly. */
export const T0 = 1_700_000_000_000;

// ---- resolve-existing -------------------------------------------------------

const RUN = (o: Obj = {}) => ({
  exitCode: null,
  signal: false,
  outputPending: false,
  startSegment: 0,
  remux: false,
  assembler: null,
  ...o,
});

const resolveInput = (
  run: Obj,
  requestedSegment: number,
  qualityMatch: boolean,
  present: number[],
) => ({
  run: RUN(run),
  requestedSegment,
  qualityMatch,
  present,
});

const asm = (
  startSegment: number,
  frontier: number | null,
  segmentsPerSecond: number | null = null,
) => ({
  startSegment,
  frontier,
  segmentsPerSecond,
});

const SPEC = 'resolve-existing-session.spec';
export function resolveReplays(): SessionVector[] {
  const v = (name: string, input: unknown): SessionVector => ({
    name: `${SPEC}: ${name}`,
    source: SPEC,
    kind: 'resolve-existing',
    input,
  });
  const remux = (start: number, frontier: number | null, o: Obj = {}) => ({
    remux: true,
    startSegment: start,
    assembler: asm(start, frontier),
    ...o,
  });
  return [
    v(
      'waits on a run that has yet to write its first segment (seg 0)',
      resolveInput({}, 0, true, []),
    ),
    v(
      'waits on a run that has yet to write its first segment (seg 2)',
      resolveInput({}, 2, true, []),
    ),
    v(
      'still restarts a starting run for a segment before its start',
      resolveInput({ startSegment: 10 }, 3, true, []),
    ),
    v(
      'still restarts a starting run for a segment far past its start',
      resolveInput({}, 40, true, []),
    ),
    v(
      'respawns a SIGKILLed session',
      resolveInput({ signal: true }, 5, true, []),
    ),
    v(
      'drops a cleanly-exited session for another quality',
      resolveInput({ exitCode: 0 }, 0, false, [0]),
    ),
    v(
      'remux: waits when the request is below the frontier',
      resolveInput(remux(0, 5), 3, true, []),
    ),
    v(
      'remux: waits just past the frontier',
      resolveInput(remux(0, 5), 6, true, []),
    ),
    v(
      "remux: restarts below the run's own start",
      resolveInput(remux(10, 12), 3, true, [3]),
    ),
    v(
      'remux: restarts far past the frontier',
      resolveInput(remux(0, 5), 65, true, []),
    ),
    v(
      'remux exited: a segment past its frontier respawns',
      resolveInput(remux(0, 5, { exitCode: 0 }), 6, true, [6]),
    ),
    v(
      'remux exited: a segment inside its range serves',
      resolveInput(remux(0, 5, { exitCode: 0 }), 3, true, []),
    ),
  ];
}

const STATES: [string, Obj][] = [
  ['running', {}],
  ['exited-0', { exitCode: 0 }],
  ['crashed', { exitCode: 1 }],
  ['signaled', { signal: true }],
  ['output-pending', { exitCode: 0, outputPending: true }],
];

export function resolveMatrix(): SessionMatrix[] {
  const transcode: SessionMatrix['cases'] = [];
  const presences = (s: number): [string, number[]][] => [
    ['empty', []],
    ['run-5', range(s, s + 5)],
    ['run-20', range(s, s + 20)],
    ['run+island', [...range(s, s + 5), ...range(s + 40, s + 42)]],
    ['island-below', range(Math.max(0, s - 6), Math.max(0, s - 3))],
    ['gap', [...range(s, s + 3), ...range(s + 5, s + 9)]],
    [
      'hole-below',
      s > 8 ? [...range(s - 8, s - 6), ...range(s, s + 4)] : range(s, s + 4),
    ],
  ];
  for (const start of [0, 10, 275]) {
    for (const [pn, present] of presences(start)) {
      for (const d of [-20, -1, 0, 1, 5, 6, 15, 16, 21, 60]) {
        const requested = Math.max(0, start + d);
        for (const [sn, state] of STATES) {
          for (const match of [true, false]) {
            if (!match && d !== 0 && d !== 6) continue;
            transcode.push({
              name: `start ${start} ${pn} req ${requested} ${sn} ${match ? 'same' : 'other'} quality`,
              input: resolveInput(
                { startSegment: start, ...state },
                requested,
                match,
                present,
              ),
            });
          }
        }
      }
    }
  }
  const remuxCases: SessionMatrix['cases'] = [];
  for (const start of [0, 10]) {
    for (const frontier of [null, start, start + 5]) {
      for (const rate of [null, 0.2, 0.5, 1, 4]) {
        for (const d of [-1, 0, 3, 4, 5, 6, 7, 8, 9, 10, 20]) {
          for (const [sn, state] of STATES) {
            const requested = Math.max(0, start + d);
            remuxCases.push({
              name: `remux start ${start} frontier ${frontier} rate ${rate} req ${requested} ${sn}`,
              input: resolveInput(
                {
                  remux: true,
                  startSegment: start,
                  assembler: asm(start, frontier, rate),
                  ...state,
                },
                requested,
                true,
                [],
              ),
            });
          }
        }
      }
    }
  }
  remuxCases.push({
    name: 'remux without an assembler, exited',
    input: resolveInput({ remux: true, exitCode: 0 }, 1, true, [1]),
  });
  remuxCases.push({
    name: 'remux without an assembler, running',
    input: resolveInput({ remux: true }, 1, true, [1]),
  });
  return [
    {
      name: 'resolve-existing transcode matrix',
      source: 'synthetic',
      kind: 'resolve-existing',
      cases: transcode,
    },
    {
      name: 'resolve-existing remux matrix',
      source: 'synthetic',
      kind: 'resolve-existing',
      cases: remuxCases,
    },
  ];
}

// ---- throttle ---------------------------------------------------------------

const THR = 'ffmpeg-throttle.service.spec';
const viewer = (
  position: number,
  last: number | null = null,
  pinned = false,
) => ({
  position,
  lastRequestedSegment: last,
  pinned,
});

export function throttleReplays(): SessionVector[] {
  const out: SessionVector[] = [];
  const add = (kind: SessionKind, name: string, input: unknown) =>
    out.push({ name: `${THR}: ${name}`, source: THR, kind, input });
  const dec = (name: string, ahead: number, paused: boolean) =>
    add('throttle-decide', `decideThrottle ${name}`, {
      aheadSeconds: ahead,
      paused,
      thresholdSeconds: 90,
    });
  dec('pauses once ahead exceeds the threshold (91)', 91, false);
  dec('pauses once ahead exceeds the threshold (90)', 90, false);
  dec('resumes at half the threshold (46)', 46, true);
  dec('resumes at half the threshold (45)', 45, true);
  dec('resumes at half the threshold (0)', 0, true);
  dec('never re-pauses a paused run', 200, true);
  dec('never re-resumes a running one', 10, false);
  dec('no-op band, paused', 60, true);
  dec('no-op band, running', 60, false);
  const uni = { kind: 'uniform', segmentDuration: 3, fps: 24 };
  const uniNoFps = { kind: 'uniform', segmentDuration: 3, fps: null };
  add('job-playhead', 'jobPlayheadSeconds is null with no live session', {
    viewers: [],
    grid: uni,
  });
  add('job-playhead', 'throttles against the furthest-ahead viewer', {
    viewers: [viewer(40), viewer(100)],
    grid: uni,
  });
  add('job-playhead', 'max of heartbeat position and last requested segment', {
    viewers: [viewer(5, 10)],
    grid: uniNoFps,
  });
  add(
    'job-playhead',
    'a buffering client with no heartbeat counts its requested segment',
    {
      viewers: [viewer(0, 20)],
      grid: uniNoFps,
    },
  );
  add(
    'job-playhead',
    'a remux requested segment goes through the assembler grid',
    {
      viewers: [viewer(0, 4)],
      grid: { kind: 'remux', boundaries: [0, 0, 0, 0, 35] },
    },
  );
  add('throttle-eligible', 'excludes the early companion', {
    variant: { kind: 'early' },
    viewers: [],
  });
  add('throttle-eligible', 'excludes a run backing a pinned session (main)', {
    variant: { kind: 'main' },
    viewers: [viewer(0, null, true)],
  });
  add('throttle-eligible', 'excludes a run backing a pinned session (remux)', {
    variant: {
      kind: 'remux',
      audioIndex: 0,
      keyframeGrid: true,
      multiAudio: false,
    },
    viewers: [viewer(0), viewer(0, null, true)],
  });
  add('throttle-eligible', 'includes a plain main run', {
    variant: { kind: 'main' },
    viewers: [viewer(0)],
  });
  add('throttle-eligible', 'includes a plain remux run', {
    variant: {
      kind: 'remux',
      audioIndex: 0,
      keyframeGrid: true,
      multiAudio: false,
    },
    viewers: [],
  });
  const span = { startSeconds: 1650, frontierSeconds: 1800 };
  for (const p of [1700, 1650, 0, 1600])
    add('run-lead', `runLeadSeconds playhead ${p}`, { span, playhead: p });
  const tick = (name: string, present: number[], position: number) =>
    add('throttle-tick', `transcode run frontier: ${name}`, {
      capability: 'signal',
      enabled: true,
      thresholdSeconds: 90,
      paused: false,
      processExited: false,
      variant: { kind: 'main' },
      viewers: [viewer(position)],
      run: {
        kind: 'transcode',
        startSegment: 275,
        frontierHint: null,
        present,
        segmentDuration: 6,
        fps: null,
      },
    });
  tick(
    "ignores another process's segments past a gap",
    range(310, 360),
    275 * 6,
  );
  tick(
    "measures the run's own output (not yet ahead)",
    range(275, 280),
    275 * 6,
  );
  tick('pauses once it leads by the threshold', range(275, 300), 275 * 6);
  tick('does not pause against an unreported viewer', range(275, 300), 0);
  add('throttle-tick', 'tick re-entrancy: throttle off, nothing paused', {
    capability: 'signal',
    enabled: false,
    thresholdSeconds: 90,
    paused: false,
    processExited: false,
    variant: { kind: 'main' },
    viewers: [],
    run: {
      kind: 'transcode',
      startSegment: 0,
      frontierHint: null,
      present: [],
      segmentDuration: 3,
      fps: null,
    },
  });
  return out;
}

const tickInput = (o: Obj): Obj => ({
  capability: 'signal',
  enabled: true,
  thresholdSeconds: 90,
  paused: false,
  processExited: false,
  variant: { kind: 'main' },
  viewers: [viewer(0)],
  run: {
    kind: 'transcode',
    startSegment: 0,
    frontierHint: null,
    present: [],
    segmentDuration: 3,
    fps: null,
  },
  ...o,
});

export function throttleMatrix(): SessionMatrix[] {
  const decide: SessionMatrix['cases'] = [];
  for (const th of [30, 90]) {
    for (const paused of [false, true]) {
      for (const ahead of [
        -5,
        0,
        th / 2 - 1,
        th / 2,
        th / 2 + 1,
        th - 1,
        th,
        th + 1,
        th * 3,
      ]) {
        decide.push({
          name: `ahead ${ahead} threshold ${th} ${paused ? 'paused' : 'running'}`,
          input: { aheadSeconds: ahead, paused, thresholdSeconds: th },
        });
      }
    }
  }
  const tick: SessionMatrix['cases'] = [];
  const variants = [
    { kind: 'main' },
    { kind: 'early' },
    { kind: 'remux', audioIndex: 0, keyframeGrid: true, multiAudio: false },
    null,
  ];
  for (const capability of ['stdin', 'signal', 'none']) {
    for (const enabled of [true, false]) {
      for (const paused of [false, true]) {
        for (const processExited of [false, true]) {
          for (const variant of variants) {
            for (const viewers of [
              [],
              [viewer(0)],
              [viewer(20)],
              [viewer(150)],
              [viewer(120), viewer(10, null, true)],
            ]) {
              tick.push({
                name: `${capability} ${enabled ? 'on' : 'off'} ${paused ? 'paused' : 'running'} ${processExited ? 'exited' : 'alive'} ${variant?.kind ?? 'none'} ${viewers.length} viewers`,
                input: tickInput({
                  capability,
                  enabled,
                  paused,
                  processExited,
                  variant,
                  viewers,
                  run: {
                    kind: 'transcode',
                    startSegment: 5,
                    frontierHint: null,
                    present: range(5, 60),
                    segmentDuration: 3,
                    fps: 24,
                  },
                }),
              });
            }
          }
        }
      }
    }
  }
  for (const [start, frontier] of [
    [0, 100],
    [20, 120],
    [null, null],
    [20, null],
  ] as const) {
    for (const position of [0, 10, 25, 60, 200]) {
      for (const paused of [false, true]) {
        tick.push({
          name: `remux span ${start}-${frontier} playhead ${position} ${paused ? 'paused' : 'running'}`,
          input: tickInput({
            paused,
            viewers: [viewer(position, 3)],
            variant: {
              kind: 'remux',
              audioIndex: 0,
              keyframeGrid: true,
              multiAudio: false,
            },
            run: {
              kind: 'remux',
              startSeconds: start,
              frontierSeconds: frontier,
              boundaries: [0, 7, 14, 21, 28],
            },
          }),
        });
      }
    }
  }
  return [
    {
      name: 'throttle decide matrix',
      source: 'synthetic',
      kind: 'throttle-decide',
      cases: decide,
    },
    {
      name: 'throttle tick matrix',
      source: 'synthetic',
      kind: 'throttle-tick',
      cases: tick,
    },
  ];
}

// ---- keys, lifetimes, cache ---------------------------------------------------

const HOUR = 3_600_000;
const entry = (
  owner: number | null,
  mediaFileId: number,
  profile: string,
  totalBytes: number,
  ageMs: number,
  live = false,
) => ({
  owner,
  mediaFileId,
  profile,
  totalBytes,
  lastAccessMs: T0 - ageMs,
  live,
});
const gcInput = (
  entries: Obj[],
  ttlMs = 4 * HOUR,
  maxBytes = 20 * 1024 * 1024 * 1024,
) => ({
  nowMs: T0,
  policy: { ttlMs, maxBytes },
  entries,
});

export function cacheReplays(): SessionVector[] {
  const TC = 'transcode-cache.service.spec';
  const LC = 'streaming-lifecycle.spec';
  return [
    {
      name: `${TC}: evicts entries past their TTL on gc`,
      source: TC,
      kind: 'cache-gc',
      input: gcInput([entry(1, 1, 'aaa', 1000, 5 * HOUR)]),
    },
    {
      name: `${TC}: keeps fresh entries through gc`,
      source: TC,
      kind: 'cache-gc',
      input: gcInput([entry(1, 1, 'aaa', 1000, 1000)]),
    },
    {
      name: `${TC}: never evicts a directory backed by a live session, even past TTL`,
      source: TC,
      kind: 'cache-gc',
      input: gcInput([
        entry(1, 1, 'aaa', 1000, 9 * HOUR, true),
        entry(1, 2, 'aaa', 1000, 9 * HOUR),
      ]),
    },
    {
      name: `${LC}: TTL eviction drops idle cache entries`,
      source: LC,
      kind: 'cache-gc',
      input: gcInput([
        entry(1, 1, 'eee', 1000, 1000),
        entry(1, 2, 'eee', 1000, 5 * HOUR),
        entry(1, 3, 'eee', 1000, 5 * HOUR),
      ]),
    },
    {
      name: `${LC}: LRU drops the least recent under size pressure`,
      source: LC,
      kind: 'cache-gc',
      input: gcInput(
        [
          entry(1, 1, 'eee', 1000, 3000),
          entry(1, 2, 'eee', 1000, 1000),
          entry(1, 3, 'eee', 1000, 2000),
        ],
        4 * HOUR,
        2000,
      ),
    },
  ];
}

export function cacheMatrix(): SessionMatrix {
  const cases: SessionMatrix['cases'] = [];
  for (const ttl of [HOUR, 4 * HOUR]) {
    for (const max of [500, 2500, 1e9]) {
      for (const live of [false, true]) {
        for (const ages of [
          [0, 1000, 2000],
          [2 * HOUR, 5 * HOUR, 1000],
          [ttl, ttl + 1000, ttl - 1000],
          [9 * HOUR, 8 * HOUR, 7 * HOUR],
        ]) {
          cases.push({
            name: `ttl ${ttl / HOUR}h max ${max} ${live ? 'first live' : 'none live'} ages ${ages.map((a) => a / 1000).join('/')}s`,
            input: gcInput(
              ages.map((age, n) =>
                entry(
                  n === 1 ? null : 1,
                  n + 1,
                  'p',
                  1000,
                  age,
                  live && n === 0,
                ),
              ),
              ttl,
              max,
            ),
          });
        }
      }
    }
  }
  return {
    name: 'cache gc matrix',
    source: 'synthetic',
    kind: 'cache-gc',
    cases,
  };
}

export function keysMatrix(): SessionMatrix {
  const cases: SessionMatrix['cases'] = [];
  const variants = [
    { kind: 'main' },
    { kind: 'early' },
    ...[null, 0, 2].flatMap((audioIndex) =>
      [true, false].flatMap((keyframeGrid) =>
        [true, false].map((multiAudio) => ({
          kind: 'remux',
          audioIndex,
          keyframeGrid,
          multiAudio,
        })),
      ),
    ),
  ];
  for (const variant of variants) {
    for (const ownerId of [null, 4]) {
      cases.push({
        name: `${JSON.stringify(variant)} owner ${ownerId}`,
        input: {
          mediaFileId: 12,
          ownerId,
          base: '0123abcdef',
          variant,
          raw: '0123abcdef-early',
        },
      });
    }
  }
  for (const raw of [
    '',
    'h',
    'h-early',
    'h-early-early',
    'h-remux',
    'h-remux-u',
    'h-remux-a1',
    'h-remux-a12-u',
    'h-remux-a',
    'h-remux-a-u',
    'h-remux-ax',
    'h-remux-u-early',
    'h-remux-early',
    'h-remuxx',
    'h-Early',
    'h~i12ab-early',
    '-early',
    'early',
    'h-remux-a1-u-u',
    'h-remux-a١',
    'a-b-c-remux-a3',
  ]) {
    cases.push({
      name: `strip ${JSON.stringify(raw)}`,
      input: {
        mediaFileId: 1,
        ownerId: null,
        base: 'b',
        variant: { kind: 'main' },
        raw,
      },
    });
  }
  return {
    name: 'session keys matrix',
    source: 'synthetic',
    kind: 'keys',
    cases,
  };
}

export function lifetimeMatrix(): SessionMatrix[] {
  const gc: SessionMatrix['cases'] = [];
  for (const age of [
    0, 29_999, 30_000, 30_001, 60_000, 899_999, 900_000, 900_001, 3_599_999,
    3_600_000, 3_600_001, 4_000_000,
  ]) {
    for (const pinned of [false, true]) {
      gc.push({
        name: `idle ${age}ms ${pinned ? 'pinned' : 'plain'}`,
        input: { nowMs: T0, sessions: [{ lastBeatMs: T0 - age, pinned }] },
      });
    }
  }
  const cap: SessionMatrix['cases'] = [];
  for (const n of [0, 1, 9, 10, 11, 12]) {
    for (const shape of ['ascending', 'descending', 'ties', 'old-last']) {
      const beats = range(0, n - 1).map((i) =>
        shape === 'ascending'
          ? 1000 + i
          : shape === 'descending'
            ? 5000 - i
            : shape === 'ties'
              ? 777
              : i === n - 1
                ? 1
                : 100 + i,
      );
      cap.push({
        name: `${n} sessions ${shape}`,
        input: { lastBeatsMs: beats },
      });
    }
  }
  const idle: SessionMatrix['cases'] = [];
  const grace = 60_000;
  const fallback = 1_800_000;
  for (const hasBaseHash of [true, false]) {
    for (const viewers of [0, 2]) {
      for (const processRunning of [true, false]) {
        for (const state of [
          { seenAnyViewer: false, zeroViewersSinceMs: null },
          { seenAnyViewer: true, zeroViewersSinceMs: null },
          { seenAnyViewer: true, zeroViewersSinceMs: T0 - grace },
          { seenAnyViewer: true, zeroViewersSinceMs: T0 - grace + 1 },
        ]) {
          for (const idleMs of [
            0,
            grace - 1,
            grace,
            fallback - 1,
            fallback,
            fallback + 1,
          ]) {
            idle.push({
              name: `${hasBaseHash ? 'paired' : 'unpaired'} ${viewers} viewers ${processRunning ? 'running' : 'exited'} ${JSON.stringify(state)} idle ${idleMs}`,
              input: {
                nowMs: T0,
                lastAccessMs: T0 - idleMs,
                hasBaseHash,
                viewers,
                processRunning,
                state,
              },
            });
          }
        }
      }
    }
  }
  const gate: SessionMatrix['cases'] = [];
  for (const sidPresent of [true, false])
    for (const known of [true, false])
      gate.push({
        name: `sid ${sidPresent} known ${known}`,
        input: { sidPresent, known },
      });
  return [
    {
      name: 'live session gc and revive matrix',
      source: 'synthetic',
      kind: 'live-gc',
      cases: gc,
    },
    {
      name: 'live session cap matrix',
      source: 'synthetic',
      kind: 'live-cap',
      cases: cap,
    },
    {
      name: 'job idle matrix',
      source: 'synthetic',
      kind: 'job-idle',
      cases: idle,
    },
    {
      name: 'sid gate matrix',
      source: 'synthetic',
      kind: 'sid-gate',
      cases: gate,
    },
  ];
}

export function allVectors(): (SessionVector | SessionMatrix)[] {
  return [
    ...resolveReplays(),
    ...throttleReplays(),
    ...cacheReplays(),
    ...resolveMatrix(),
    ...throttleMatrix(),
    cacheMatrix(),
    keysMatrix(),
    ...lifetimeMatrix(),
  ];
}

// ---- differential fuzz --------------------------------------------------------

function genPresent(r: Rng, start: number): number[] {
  const out = new Set<number>();
  if (chance(r, 0.75)) {
    const from = chance(r, 0.8) ? start : Math.max(0, start - rint(r, 1, 12));
    for (const n of range(from, from + rint(r, 0, 40))) out.add(n);
  }
  for (let k = rint(r, 0, 3); k > 0; k--) {
    const s = rint(r, 0, start + 80);
    for (const n of range(s, s + rint(r, 0, 5))) out.add(n);
  }
  if (out.size > 3 && chance(r, 0.3)) out.delete(pick(r, [...out]));
  return [...out].sort((a, b) => a - b);
}

function genResolve(r: Rng): Obj {
  const start = chance(r, 0.6)
    ? pick(r, [0, 0, 1, 5, 10, 50, 275])
    : rint(r, 0, 400);
  const state = pick(r, [
    STATES[0],
    STATES[0],
    STATES[0],
    STATES[1],
    STATES[2],
    STATES[3],
    STATES[4],
  ])[1];
  const remux = chance(r, 0.25);
  const frontier = chance(r, 0.25) ? null : start + rint(r, -3, 30);
  const requested = chance(r, 0.85)
    ? Math.max(0, start + rint(r, -20, 60))
    : rint(r, 0, 500);
  return resolveInput(
    {
      startSegment: start,
      ...state,
      remux,
      assembler:
        remux && chance(r, 0.95)
          ? asm(
              chance(r, 0.85) ? start : rint(r, 0, 400),
              frontier == null ? null : Math.max(0, frontier),
              chance(r, 0.4)
                ? null
                : pick(r, [0, 0.1, 0.2, 0.34, 0.5, 0.83, 1.5, 2, 7.2]),
            )
          : null,
    },
    requested,
    chance(r, 0.8),
    genPresent(r, start),
  );
}

const genViewers = (r: Rng) =>
  range(1, rint(r, 0, 4)).map(() =>
    viewer(
      chance(r, 0.3) ? 0 : Math.round(r() * 4000 * 100) / 100,
      chance(r, 0.5) ? null : rint(r, 0, 800),
      chance(r, 0.1),
    ),
  );

const genGrid = (r: Rng) =>
  chance(r, 0.7)
    ? {
        kind: 'uniform',
        segmentDuration: pick(r, [1, 2, 3, 4, 6, 10]),
        fps: pick(r, [null, 23.976, 24, 25, 29.97, 30, 59.94]),
      }
    : {
        kind: 'remux',
        boundaries: range(0, rint(r, 0, 30)).map(
          (i) => i * 7 + Math.round(r() * 30) / 10,
        ),
      };

function genTick(r: Rng): Obj {
  const transcode = chance(r, 0.75);
  const start = rint(r, 0, 400);
  const run = transcode
    ? {
        kind: 'transcode',
        startSegment: start,
        frontierHint: chance(r, 0.5)
          ? null
          : Math.max(0, start + rint(r, -2, 30)),
        present: chance(r, 0.5)
          ? range(start, start + rint(r, 0, 90))
          : genPresent(r, start),
        segmentDuration: pick(r, [2, 3, 6]),
        fps: pick(r, [null, 24, 23.976, 25]),
      }
    : {
        kind: 'remux',
        startSeconds: chance(r, 0.2) ? null : Math.round(r() * 500 * 10) / 10,
        frontierSeconds: chance(r, 0.2)
          ? null
          : Math.round(r() * 900 * 10) / 10,
        boundaries: range(0, rint(r, 0, 20)).map((i) => i * 9),
      };
  const startSec = transcode ? start * (run as Obj).segmentDuration : 0;
  const viewers = genViewers(r).map((v, n) =>
    n === 0 && chance(r, 0.6)
      ? { ...v, position: startSec + rint(r, 0, 300), pinned: false }
      : v,
  );
  return tickInput({
    capability: pick(r, [
      'stdin',
      'signal',
      'signal',
      'signal',
      'stdin',
      'signal',
      'signal',
      'signal',
      'signal',
      'none',
    ]),
    enabled: chance(r, 0.9),
    thresholdSeconds: pick(r, [30, 60, 90, 120]),
    paused: chance(r, 0.4),
    processExited: chance(r, 0.05),
    variant: pick(r, [
      { kind: 'main' },
      { kind: 'main' },
      { kind: 'main' },
      { kind: 'main' },
      { kind: 'main' },
      { kind: 'main' },
      { kind: 'early' },
      { kind: 'remux', audioIndex: 1, keyframeGrid: false, multiAudio: false },
      null,
    ]),
    viewers,
    run,
  });
}

const genVariant = (r: Rng): Obj =>
  pick(r, [
    { kind: 'main' },
    { kind: 'early' },
    {
      kind: 'remux',
      audioIndex: pick(r, [null, 0, 1, 12]),
      keyframeGrid: chance(r, 0.5),
      multiAudio: chance(r, 0.5),
    },
  ]);

const genKeys = (r: Rng): Obj => {
  const hex = () =>
    range(1, 10)
      .map(() => '0123456789abcdef'[rint(r, 0, 15)])
      .join('');
  const parts = [
    '-early',
    '-remux',
    '-remux-a1',
    '-remux-a23-u',
    '-remux-u',
    '-u',
    '-a2',
    '~ia1b2c3d4',
    '-x',
    '-remux-a',
    '',
  ];
  let raw = hex();
  for (let k = rint(r, 0, 3); k > 0; k--) raw += pick(r, parts);
  return {
    mediaFileId: rint(r, 1, 9999),
    ownerId: chance(r, 0.3) ? null : rint(r, 1, 50),
    base: hex(),
    variant: genVariant(r),
    raw,
  };
};

const genGc = (r: Rng): Obj => {
  const n = rint(r, 0, 8);
  const ttl = pick(r, [HOUR, 2 * HOUR, 4 * HOUR]);
  const ages = new Set<number>();
  const entries = range(1, n).map((i) => {
    let age: number;
    do
      age = chance(r, 0.3)
        ? ttl + pick(r, [-2000, -1000, 0, 1000, 2000, 1000 * rint(r, 1, 9)])
        : 1000 * rint(r, 1, 3 * 3600);
    while (ages.has(age));
    ages.add(age);
    return entry(
      chance(r, 0.2) ? null : rint(r, 1, 3),
      i,
      pick(r, ['p', 'q']),
      100 * rint(r, 1, 30),
      age,
      chance(r, 0.2),
    );
  });
  return gcInput(entries, ttl, 100 * rint(r, 1, 120));
};

const genIdle = (r: Rng): Obj => {
  const grace = 60_000;
  const fallback = 1_800_000;
  const near = (x: number) =>
    Math.max(0, x + pick(r, [-1, 0, 1, rint(r, -5000, 5000)]));
  const zero = chance(r, 0.5) ? null : T0 - near(grace);
  return {
    nowMs: T0,
    lastAccessMs:
      T0 - pick(r, [near(grace), near(fallback), rint(r, 0, 3_600_000)]),
    hasBaseHash: chance(r, 0.85),
    viewers: chance(r, 0.4) ? rint(r, 1, 3) : 0,
    processRunning: chance(r, 0.7),
    state: { seenAnyViewer: chance(r, 0.6), zeroViewersSinceMs: zero },
  };
};

const genLiveGc = (r: Rng): Obj => ({
  nowMs: T0,
  sessions: range(1, rint(r, 1, 6)).map(() => ({
    lastBeatMs:
      T0 -
      pick(r, [
        29_999,
        30_000,
        30_001,
        900_000,
        900_001,
        3_600_000,
        3_600_001,
        rint(r, 0, 5_000_000),
      ]),
    pinned: chance(r, 0.3),
  })),
});

const genCap = (r: Rng): Obj => ({
  lastBeatsMs: range(1, rint(r, 3, 13)).map(() =>
    pick(r, [777, rint(r, 0, 9000)]),
  ),
});

/** Share of `FUZZ_COUNT` per kind: the seek matrix and the throttle predicates get the most. */
export const FUZZ_KINDS: {
  kind: SessionKind;
  weight: number;
  gen: (r: Rng) => Obj;
}[] = [
  { kind: 'resolve-existing', weight: 1, gen: genResolve },
  {
    kind: 'throttle-decide',
    weight: 1,
    gen: (r) => ({
      aheadSeconds: pick(r, [rint(r, -50, 400), 45, 46, 90, 91, 60, 0.5]),
      paused: chance(r, 0.5),
      thresholdSeconds: pick(r, [30, 60, 90, 90.5, 120]),
    }),
  },
  {
    kind: 'run-lead',
    weight: 0.3,
    gen: (r) => {
      const start = rint(r, 0, 3000);
      return {
        span: { startSeconds: start, frontierSeconds: start + rint(r, 0, 500) },
        playhead: pick(r, [rint(r, 0, 4000), start, start - 1, start + 0.5]),
      };
    },
  },
  {
    kind: 'job-playhead',
    weight: 0.5,
    gen: (r) => ({ viewers: genViewers(r), grid: genGrid(r) }),
  },
  {
    kind: 'throttle-eligible',
    weight: 0.3,
    gen: (r) => ({
      variant: pick(r, [
        { kind: 'main' },
        { kind: 'early' },
        { kind: 'remux', audioIndex: 0, keyframeGrid: true, multiAudio: false },
        null,
      ]),
      viewers: genViewers(r),
    }),
  },
  { kind: 'throttle-tick', weight: 1, gen: genTick },
  { kind: 'keys', weight: 0.5, gen: genKeys },
  { kind: 'job-idle', weight: 0.5, gen: genIdle },
  { kind: 'cache-gc', weight: 0.1, gen: genGc },
  { kind: 'live-gc', weight: 0.2, gen: genLiveGc },
  { kind: 'live-cap', weight: 0.2, gen: genCap },
];

export function fuzzSeed(seed: number): Rng {
  return mulberry32(seed);
}
