import { QoeAggregator, mergeSummaries } from '../../src/modules/qoe/core/aggregate';
import { classifyStall } from '../../src/modules/qoe/core/classify-stall';
import { diagnose } from '../../src/modules/qoe/core/diagnose';
import { parseEvents, parsePlaybackId, parseSample } from '../../src/modules/qoe/core/validate';
import { readCmcd, readCmcdRaw } from '../../src/modules/qoe/core/cmcd';
import { emit, maybe, mulberry32, pick, ri } from './_util';

const NOW = 1_700_000_000_000;
const AT = 100_000;
const SKEW = 5000;
const stall = { at: AT, durationMs: 4_000 };
const ctx = (o: object = {}) => ({ segments: [], samples: [], bufferAheadS: null, bandwidthBps: null, variantBitrate: null, ...o });
const seg = (at: number, waitedMs: number | null, dur = 6) => ({ at, segmentDurationS: dur, waitedMs });
const pipeline = { source: null, output: null, decode: null, encode: { hw: false, kind: 'cpu' }, tonemap: 'cpu', burnIn: 'text', crop: null, audioTranscode: null };
const load = { activeTranscodes: 3, activeSessions: 4, loadAvg1: 8, cpuCount: 4 };
const dropSamples = (dropped: number) => [
  { at: AT - 10_000, droppedFrames: 0, decodedFrames: 0 },
  { at: AT + 1_000, droppedFrames: dropped, decodedFrames: 600 },
];
const sample = (o: object = {}) => ({
  engine: 'shaka', cmcd: false, droppedFrames: 0, decodedFrames: 0, bandwidthBps: null, bufferAheadS: null,
  variantBitrate: null, width: null, height: null, videoCodec: null, decoderName: null, hwDecoder: null,
  stallCount: 0, stallMs: 0, recoveryReloads: 0, ...o,
});
const base = {
  engine: 'shaka', cmcd: false, cmcdClaimed: false, videoCodec: 'hevc', width: 1920, height: 1080, decoderName: null,
  hwDecoder: true, watchedMs: 20 * 60_000, stallCount: 0, stallMs: 0, droppedFrames: 0, decodedFrames: 10_000,
  recoveryReloads: 0, errorCount: 0, unrecoveredError: false, bandwidthBps: null, variantBitrate: null, bufferAheadS: null,
  avgBandwidthBps: null, minBandwidthBps: null, avgVariantBitrate: null, stallBufferAheadS: null, stallBandwidthBps: null,
  cmcdThroughputBps: null, medianTranscodeSpeed: null, stallCauseMs: null, stallReasonMs: null, sampleCount: 10,
};
const part = (o: object = {}) => ({ ...new QoeAggregator().summary(), ...o });
const stalls = { stallCount: 3, stallMs: 9_000 };
const cms = (o: object) => ({ server: 0, network: 0, device: 0, unknown: 0, ...o });

const cls = (s: object, c: object) => ({ fn: 'classifyStall', stall: s, ctx: c });
const dg = (o: object, live = false) => ({ fn: 'diagnose', summary: { ...base, ...o }, live });
const ev = (raw: unknown, now = NOW, sentAt: number | null = null) => ({ fn: 'parseEvents', raw, now, sentAt });
const smp = (raw: unknown) => ({ fn: 'parseSample', raw });
const cmcd = (req: object) => ({ fn: 'readCmcd', req });
const cmcdRaw = (raw: string) => ({ fn: 'readCmcdRaw', raw });
type Step = { op: string; [k: string]: unknown };
const agg = (...steps: Step[]) => ({ fn: 'aggregate', steps });
const S = (s: object, now: number, playing = true): Step => ({ op: 'sample', s: sample(s), now, playing });
const E = (e: object, now: number, opts: object = {}): Step => ({ op: 'event', e, now, opts });
const G = (m: object, now: number): Step => ({ op: 'segment', m, now });
const C = (c: object, now: number): Step => ({ op: 'cmcd', c, now });
const merge = (...parts: object[]) => ({ fn: 'merge', parts });

// ---- spec-derived inputs ----
const specInputs: unknown[] = [
  // classify-stall.spec.ts
  cls(stall, ctx({ segments: [seg(AT - 2_000, 3_200)] })),
  cls(stall, ctx({ segments: [seg(AT - 2_000, 3_200)], pipeline, load })),
  cls(stall, ctx({ segments: [seg(AT - 2_000, 3_200)], pipeline, load: { ...load, activeTranscodes: 1 } })),
  cls(stall, ctx({ pipeline, load })),
  cls({ ...stall, bufferAheadS: 0.2, bandwidthBps: 1e6, variantBitrate: 5e6 }, ctx({ segments: [seg(AT - 1_000, 2_000)] })),
  cls({ ...stall, bufferAheadS: 2.5 }, ctx({ segments: [seg(AT - 2_000, 3_200)] })),
  cls(stall, ctx({ segments: [seg(AT - 1_000, 900, 0.5)] })),
  cls(stall, ctx({ segments: [seg(AT + SKEW - 500, 1_500)] })),
  cls(stall, ctx({ segments: [seg(AT + SKEW + 2_000, 1_500), seg(AT - 1_000, 300)], bufferAheadS: 3 })),
  cls(stall, ctx({ segments: [seg(AT - 1_000, 6_200)], live: true, bufferAheadS: 0.5 })),
  cls(stall, ctx({ segments: [seg(AT - 1_000, 7_500)], live: true, bufferAheadS: 0.5 })),
  cls({ ...stall, bufferAheadS: 0.4, bandwidthBps: 1.9e6, variantBitrate: 5.5e6 }, ctx()),
  cls(stall, ctx({ bufferAheadS: 0.5, bandwidthBps: 4e6, variantBitrate: 5e6 })),
  cls({ ...stall, bufferAheadS: 0.2, bandwidthBps: 20e6, variantBitrate: 5e6 }, ctx()),
  cls({ ...stall, bufferAheadS: 0 }, ctx()),
  cls(stall, ctx({ bandwidthBps: 1e6, variantBitrate: 5e6 })),
  cls({ ...stall, bufferAheadS: 2.1 }, ctx()),
  cls(stall, ctx({ samples: dropSamples(90) })),
  cls({ ...stall, bufferAheadS: 0.1, bandwidthBps: 20e6, variantBitrate: 5e6 }, ctx({ samples: dropSamples(90) })),
  cls(stall, ctx({ samples: dropSamples(30) })),
  cls(stall, ctx()),
  // diagnose.spec.ts
  dg({ unrecoveredError: true, ...stalls, medianTranscodeSpeed: 0.5 }),
  dg({ ...stalls, medianTranscodeSpeed: 0.7, stallBufferAheadS: 0 }),
  dg({ ...stalls, medianTranscodeSpeed: 0.95 }, true),
  dg({ ...stalls, medianTranscodeSpeed: 0.95 }),
  dg({ ...stalls, medianTranscodeSpeed: 0.8 }, true),
  dg({ ...stalls, stallBufferAheadS: 0.2, stallBandwidthBps: 5_000_000, avgVariantBitrate: 8_000_000 }),
  dg({ ...stalls, cmcdThroughputBps: 5_000_000, avgVariantBitrate: 8_000_000 }),
  dg({ ...stalls, avgBandwidthBps: 2_000_000, avgVariantBitrate: 8_000_000 }),
  dg({ ...stalls, stallBufferAheadS: 0 }),
  dg({ ...stalls, stallBufferAheadS: 12 }),
  dg({ ...stalls, stallBufferAheadS: 0, avgBandwidthBps: 50_000_000, avgVariantBitrate: 8_000_000 }),
  dg({ watchedMs: 120 * 60_000, stallCount: 1, stallMs: 2_000 }),
  dg({ watchedMs: 120 * 60_000, stallCount: 1, stallMs: 120_000, stallBufferAheadS: 5 }),
  dg({ droppedFrames: 600 }),
  dg({ droppedFrames: 5, decodedFrames: 50 }),
  dg({ hwDecoder: false }),
  dg({ hwDecoder: false, droppedFrames: 600 }),
  dg({ hwDecoder: false, droppedFrames: 600, height: 480 }),
  dg({ ...stalls, medianTranscodeSpeed: 0.5, stallCauseMs: cms({ network: 6_000, device: 3_000 }) }),
  ...[
    ['qoe.stall.network_unconfirmed', 'network'], ['qoe.stall.device_dropped_frames', 'device'],
    ['qoe.stall.network_starved', 'network'], ['qoe.stall.server_session_lost', 'server'],
    ['qoe.stall.server_session_expired', 'server'],
  ].map(([k, c]) => dg({ ...stalls, stallCauseMs: cms({ [c]: 5_000 }), stallReasonMs: { [k]: 5_000 } })),
  dg({ ...stalls, stallCauseMs: cms({ device: 1_000, server: 8_000 }) }),
  dg({ ...stalls, stallCauseMs: cms({ network: 4_000, device: 3_500, server: 1_500 }) }),
  dg({ ...stalls, medianTranscodeSpeed: 0.5, stallCauseMs: cms({ unknown: 9_000 }) }),
  dg({ stallCauseMs: cms({ network: 500 }) }),
  dg({ watchedMs: 30_000 }),
  dg({}),
  dg({ sampleCount: 0 }),
  dg({ cmcdClaimed: true, cmcd: false }),
  // validate.spec.ts
  smp({ engine: 'shaka', cmcd: true, droppedFrames: -1, decodedFrames: 100, bandwidthBps: Infinity, decoderName: 'x'.repeat(500), hwDecoder: 'yes', stallCount: 2, evil: 'x' }),
  smp({ engine: 'vlc' }), smp('x'), smp(null),
  smp({ engine: 'mpv', width: 1919.6, height: 1e12, droppedFrames: 3.4, stallCount: 2 ** 40 }),
  smp({ engine: 'mpv', decoderName: 'x\u0000y' }),
  smp({ engine: 'mpv', stallMs: 1e15 }),
  smp({ engine: 'cast', playbackId: 'abc_DEF-123' }),
  smp({ engine: 'cast', playbackId: 'bad id!' }),
  { fn: 'parsePlaybackId', raw: 'abc_DEF-123' }, { fn: 'parsePlaybackId', raw: 'x'.repeat(65) },
  { fn: 'parsePlaybackId', raw: 'a b' }, { fn: 'parsePlaybackId', raw: 5 },
  ev([{ type: 'error', at: 1, message: 'a\u0000b', category: '\u0000' }], 1),
  ev([{ type: 'stall', at: 1, durationMs: 1e15 }], 1),
  ev(Array.from({ length: 80 }, () => ({ type: 'stall', at: 1 })), 1),
  ev([{ type: 'bogus', at: 1 }, 'x']), ev({}),
  ...[NOW - 3_600_000, 1, NOW + 2 * 86_400_000, undefined].map((at) => ev([{ type: 'stall', at }])),
  ...['session_lost', 'stall', 'bogus'].map((reason) => ev([{ type: 'recovery', at: 1, reason }], 1)),
  ev([{ type: 'error', at: NOW, position: 'x', code: 3016, message: 'm'.repeat(1000), category: 'decode', durationMs: -1, junk: 1 }]),
  ev([{ type: 'stall', at: NOW - 60_000, position: 1 }], NOW, NOW - 30_000),
  ev([{ type: 'stall', at: NOW - 5, position: 1 }], NOW, null),
  ev([{ type: 'stall', at: NOW - 5, position: 1 }], NOW, NOW - 3 * 86_400_000),
  ev([
    { type: 'reload', at: NOW, reason: 'audio', from: 'Français 5.1', to: 'x'.repeat(200) },
    { type: 'reload', at: NOW, reason: 'bogus', from: 3 },
    { type: 'stall', at: NOW, reason: 'audio', from: 'x' },
  ]),
  ev([{ type: 'stall', at: NOW, position: 1, variantBitrate: 5e6, cause: 'server' }]),
  // cmcd.spec.ts
  cmcd({ query: { CMCD: 'bl=2100,br=3000,mtp=25400,su,sid="x",ot=v' } }),
  cmcd({ headers: { 'cmcd-request': 'mtp=25400,bl=2100', 'cmcd-object': 'br=3000,tb=8000', 'cmcd-status': 'bs', 'cmcd-session': 'sid="abc"' } }),
  cmcd({ query: { CMCD: 'bl=1' }, headers: { 'cmcd-request': 'bl=9' } }),
  cmcd({ query: { sid: 'a' }, headers: {} }), cmcd({ query: { CMCD: 'sid="x"' } }),
  cmcd({ query: { CMCD: '%%%not sfv' } }), cmcd({ query: { CMCD: ['a', 'b'] } }),
  cmcd({ query: { CMCD: 'bl=-5,mtp="x",br=100' } }),
  cmcdRaw('bl=2100,br=3000,mtp=25400,su,sid="x",ot=v'),
  cmcdRaw('mtp=25400,bl=2100,br=3000,tb=8000,bs,sid="abc"'),
  cmcdRaw('sid="a"'), cmcdRaw('%%%='),
  // aggregate.spec.ts
  agg(S({ droppedFrames: 10, decodedFrames: 1000, stallCount: 2 }, 0), S({ droppedFrames: 25, decodedFrames: 2000, stallCount: 2 }, 10_000),
    S({ droppedFrames: 3, decodedFrames: 100, stallCount: 0 }, 20_000), S({ droppedFrames: 5, decodedFrames: 300, stallCount: 1 }, 30_000)),
  agg(S({}, 0), E({ type: 'recovery', at: 1, position: 873, reason: 'session_lost', durationMs: 9000 }, 1),
    E({ type: 'recovery', at: 2, position: 900, reason: 'session_expired', durationMs: 4000 }, 2),
    E({ type: 'recovery', at: 3, position: 950, reason: 'session_lost' }, 3)),
  agg(S({}, 0), E({ type: 'reload', at: 1, position: 5, reason: 'audio' }, 1)),
  agg(S({ droppedFrames: null, decodedFrames: null }, 0)),
  agg(S({}, 0), S({}, 10_000), S({}, 20_000, false), S({}, 200_000)),
  agg(S({ bandwidthBps: 4e6, variantBitrate: 8e6, bufferAheadS: 20 }, 0), S({ bandwidthBps: 2e6, variantBitrate: 8e6, bufferAheadS: 0.5 }, 10_000)),
  agg(S({}, 0), E({ type: 'error', at: 1, position: 5 }, 5_000), S({}, 15_000)),
  agg(E({ type: 'error', at: 1, position: 5 }, 5_000), E({ type: 'recovery', at: 2, position: 5 }, 6_000)),
  agg(E({ type: 'recovery', at: 1, position: 5 }, 5_000), E({ type: 'error', at: 2, position: 5 }, 5_000), E({ type: 'recovery', at: 3, position: 5 }, 5_000)),
  agg(...[0, 0.4, 9].map((b) => E({ type: 'stall', at: 1, position: 1, bufferAheadS: b, bandwidthBps: 1e6 }, 0))),
  agg(G({ segmentDurationS: 3, waitedMs: 6000 }, 1000), G({ segmentDurationS: 3, waitedMs: null }, 2000), G({ segmentDurationS: 3, waitedMs: 6000 }, 3000)),
  agg(G({ segmentDurationS: 3, waitedMs: 6000 }, 1000), G({ segmentDurationS: 3, waitedMs: null }, 2000), G({ segmentDurationS: 3, waitedMs: 6000 }, 3000), G({ segmentDurationS: 3, waitedMs: 6000 }, 4000)),
  agg(C({ mtp: 25_400, bl: 2100, br: 3000 }, 0)),
  agg(S({ bufferAheadS: 0.3 }, 100_000), E({ type: 'stall', at: 1, position: 1 }, 105_000)),
  agg(S({ bufferAheadS: 0.3 }, 0), E({ type: 'stall', at: 1, position: 1 }, 60_000)),
  agg(S({ cmcd: true }, 0), C({ bl: 4000 }, 1)),
  agg(C({ bl: 9000, ot: 'a' }, 1_000), C({ bl: 300, ot: 'v' }, 1_500), C({ bl: 9000, ot: 'a' }, 1_800), E({ type: 'stall', at: 1, position: 1 }, 2_000)),
  agg(C({ bl: 400 }, 1_000), E({ type: 'stall', at: 1, position: 1 }, 5_000)),
  agg(S({ bandwidthBps: 2e6, variantBitrate: 5e6 }, 1_000), G({ segmentDurationS: 6, waitedMs: 2_500 }, 9_000),
    E({ type: 'stall', at: 10_000, position: 1, durationMs: 3_000 }, 10_000),
    E({ type: 'stall', at: 60_000, position: 2, durationMs: 1_000, bufferAheadS: 0.2 }, 60_000), E({ type: 'error', at: 1, position: 1 }, 1)),
  agg(E({ type: 'stall', at: 1, position: 1, durationMs: 2_000, bufferAheadS: 0.2 }, 1)),
  agg(),
  agg({ op: 'pipeline', p: pipeline }, G({ segmentDurationS: 6, waitedMs: 3_000 }, 98_000), E({ type: 'stall', at: AT, position: 1, durationMs: 4_000 }, AT, { load })),
  merge(
    part({ watchedMs: 30_000, stallCount: 1, stallMs: 500, droppedFrames: 5, decodedFrames: 100, avgBandwidthBps: 2e6, minBandwidthBps: 1e6, engine: 'shaka', unrecoveredError: true, errorCount: 1, cmcdClaimed: true }),
    part({ watchedMs: 90_000, stallCount: 2, stallMs: 700, droppedFrames: null, decodedFrames: null, avgBandwidthBps: 6e6, minBandwidthBps: 3e6, engine: 'exoplayer', cmcd: true })),
  merge(part({ droppedFrames: 10, decodedFrames: null }), part({ droppedFrames: 5, decodedFrames: 100 }), part({ droppedFrames: null, decodedFrames: 50 })),
  merge(part({ stallCauseMs: cms({ network: 10 }) }), part({ stallCauseMs: null }), part({ stallCauseMs: cms({ network: 5 }) })),
  merge(part({ watchedMs: 5 })),
];
const specCount = specInputs.length;

// ---- seeded generated inputs ----
const rng = mulberry32(0x51e5eed);
const R = (lo: number, hi: number) => ri(rng, lo, hi);
const gen: unknown[] = [];
const genStall = () => ({
  at: AT, durationMs: pick(rng, [undefined, 0, 500, 4000]), bufferAheadS: maybe(rng, pick(rng, [0, 0.4, 1, 2.5, 12])),
  bandwidthBps: maybe(rng, R(5, 400) * 1e5), variantBitrate: maybe(rng, R(5, 100) * 1e5),
});
for (let i = 0; i < 70; i++) {
  const segments = Array.from({ length: R(0, 4) }, () => seg(AT + R(-12_000, 12_000), pick(rng, [null, 1, 300, 900, 1500, 3200, 7500]), pick(rng, [0.5, 3, 6])));
  let t = AT - 20_000;
  let d = 0;
  const samples = Array.from({ length: R(0, 3) }, () => ((t += R(2_000, 12_000)), { at: t, droppedFrames: maybe(rng, (d += R(0, 80)), 0.9) ?? null, decodedFrames: maybe(rng, R(0, 700), 0.9) ?? null }));
  gen.push(cls(genStall(), ctx({
    segments, samples, live: pick(rng, [undefined, true, false]), bufferAheadS: maybe(rng, pick(rng, [0.3, 3])) ?? null,
    bandwidthBps: maybe(rng, R(5, 400) * 1e5) ?? null, variantBitrate: maybe(rng, R(5, 100) * 1e5) ?? null,
    pipeline: maybe(rng, { ...pipeline, encode: pick(rng, [null, pipeline.encode, { hw: true, kind: 'vaapi' }]), burnIn: pick(rng, [null, 'text', 'image']), tonemap: pick(rng, [null, 'cpu', 'vaapi']) }),
    load: maybe(rng, { ...load, activeTranscodes: R(0, 4) }),
  })));
}
for (let i = 0; i < 70; i++) {
  const n = R(0, 3);
  const causes = maybe(rng, cms({ server: R(0, 6) * 1000, network: R(0, 6) * 1000, device: R(0, 6) * 1000, unknown: R(0, 6) * 1000 })) ?? null;
  const reasons = causes && maybe(rng, Object.fromEntries(pick(rng, [['qoe.stall.server_wait', 'qoe.stall.network_starved', 'qoe.stall.network_low_throughput', 'qoe.stall.network_unconfirmed', 'qoe.stall.device_buffer_ahead', 'qoe.stall.device_dropped_frames'], ['qoe.stall.server_session_lost', 'qoe.stall.device_buffer_ahead']]).map((k) => [k, R(1, 9) * 1000])));
  gen.push(dg({
    watchedMs: pick(rng, [30_000, 60_000, 5 * 60_000, 20 * 60_000, 120 * 60_000]), stallCount: n, stallMs: n ? R(500, 150_000) : 0,
    unrecoveredError: rng() < 0.05, droppedFrames: pick(rng, [null, 0, 5, 600]), decodedFrames: pick(rng, [null, 50, 10_000]),
    hwDecoder: pick(rng, [null, true, false]), height: pick(rng, [null, 480, 1080]), cmcd: rng() < 0.3, cmcdClaimed: rng() < 0.3, sampleCount: pick(rng, [0, 10]),
    medianTranscodeSpeed: pick(rng, [null, 0.5, 0.8, 0.95, 1.5]), stallBufferAheadS: pick(rng, [null, 0, 0.5, 5]),
    stallBandwidthBps: pick(rng, [null, 2e6, 9e6]), avgBandwidthBps: pick(rng, [null, 2e6, 50e6]), cmcdThroughputBps: pick(rng, [null, 3e6]),
    avgVariantBitrate: pick(rng, [null, 8e6]), stallCauseMs: causes, stallReasonMs: reasons,
  }, rng() < 0.3));
}
const GEN_STRINGS = ['bl=100', 'mtp=5,br=7,ot=a', 'ot=av,bl=0', 'bl=1.5,mtp=2', 'br=-1', 'ot=x', 'bs,su', 'bl=9999999999', 'sid="s",cid="c"', '', 'bl=', '=1'];
for (let i = 0; i < 20; i++) {
  const s = pick(rng, GEN_STRINGS) + (rng() < 0.4 ? ',' + pick(rng, GEN_STRINGS) : '');
  gen.push(rng() < 0.5 ? cmcdRaw(s) : cmcd(pick(rng, [{ query: { CMCD: s } }, { headers: { 'cmcd-request': s } }, { headers: { 'cmcd-object': [s, 'bl=1'] } }])));
}
const evTypes = ['stall', 'error', 'recovery', 'quality_switch', 'reload', 'bogus', 5];
for (let i = 0; i < 25; i++) {
  const raw = Array.from({ length: R(0, 4) }, () => ({
    type: pick(rng, evTypes), at: pick(rng, [NOW - R(0, 90_000), NOW + R(0, 90_000), 3, undefined, 'x', NOW - 3 * 86_400_000]),
    position: maybe(rng, R(0, 7200)), durationMs: maybe(rng, pick(rng, [-1, 0, 250, 1e15])), bufferAheadS: maybe(rng, R(0, 20)),
    bandwidthBps: maybe(rng, R(1, 9) * 1e6), variantBitrate: maybe(rng, R(1, 9) * 1e6), code: maybe(rng, pick(rng, [3016, 1.5, 'a'])),
    reason: maybe(rng, pick(rng, ['audio', 'session_lost', 'stall', 'nope'])), from: maybe(rng, pick(rng, ['a', 'é'.repeat(100), 3])), to: maybe(rng, 'b'),
    message: maybe(rng, pick(rng, ['m', '', 'n\u0000n'])), fromBitrate: maybe(rng, 1e6), toBitrate: maybe(rng, 2e6),
  }));
  gen.push(ev(raw, NOW, pick(rng, [null, NOW - R(0, 90_000), NOW - 3 * 86_400_000])));
}
for (let i = 0; i < 12; i++) {
  gen.push(smp(pick(rng, [{}, { engine: pick(rng, ['shaka', 'exoplayer', 'avplayer', 'mpv', 'avplay', 'webos', 'cast', 'x']), cmcd: rng() < 0.5, droppedFrames: pick(rng, [0, 3.6, -2, null, 1e10]), width: pick(rng, [1280, 719.5, 'w']), hwDecoder: pick(rng, [true, false, 1]), stallCount: R(0, 5), stallMs: pick(rng, [0, 1234.5, 1e15]), videoCodec: pick(rng, ['h264', 'x'.repeat(100), '']), playbackId: pick(rng, ['ok-1', '', 7]) }])));
}
for (let i = 0; i < 30; i++) {
  let now = R(0, 5000);
  let cum = { d: 0, f: 0, s: 0, m: 0 };
  const steps: Step[] = [];
  for (let j = 0, n = R(4, 14); j < n; j++) {
    now += R(500, 40_000);
    const k = rng();
    if (k < 0.35) {
      if (rng() < 0.15) cum = { d: 0, f: 0, s: 0, m: 0 };
      cum = { d: cum.d + R(0, 80), f: cum.f + R(0, 900), s: cum.s + R(0, 2), m: cum.m + R(0, 3000) };
      steps.push(S({ droppedFrames: cum.d, decodedFrames: cum.f, stallCount: cum.s, stallMs: cum.m, bandwidthBps: maybe(rng, R(5, 300) * 1e5) ?? null, variantBitrate: maybe(rng, R(10, 90) * 1e5) ?? null, bufferAheadS: maybe(rng, pick(rng, [0.2, 4])) ?? null, cmcd: rng() < 0.3 }, now, rng() < 0.85));
    } else if (k < 0.65) {
      const type = pick(rng, ['stall', 'stall', 'error', 'recovery', 'reload', 'quality_switch']);
      steps.push(E({ type, at: now, position: R(0, 3000), durationMs: maybe(rng, R(100, 9000)), bufferAheadS: maybe(rng, pick(rng, [0.1, 5])), bandwidthBps: maybe(rng, R(5, 300) * 1e5), reason: type === 'recovery' ? pick(rng, ['session_lost', 'session_expired', 'stall', 'other']) : undefined }, now, pick(rng, [{}, { live: true }, { load }, { live: false, load: null }])));
    } else if (k < 0.85) steps.push(G({ segmentDurationS: pick(rng, [0, 2, 6]), waitedMs: pick(rng, [null, 1, 800, 2500, 9000]) }, now));
    else steps.push(C({ bl: maybe(rng, R(0, 9000)), mtp: maybe(rng, R(1, 60_000)), br: maybe(rng, R(100, 9000)), ot: maybe(rng, pick(rng, ['v', 'a', 'av'])) }, now));
  }
  gen.push(agg(...steps));
}
for (let i = 0; i < 10; i++) {
  gen.push(merge(...Array.from({ length: R(1, 4) }, () => part({
    watchedMs: R(0, 100) * 1000, stallCount: R(0, 4), stallMs: R(0, 5000), droppedFrames: pick(rng, [null, 4]), decodedFrames: pick(rng, [null, 90]),
    avgBandwidthBps: pick(rng, [null, 2e6, 6e6]), minBandwidthBps: pick(rng, [null, 1e6]), medianTranscodeSpeed: pick(rng, [null, 0.8]),
    stallBufferAheadS: pick(rng, [null, 0.4]), engine: pick(rng, [null, 'shaka', 'mpv']), unrecoveredError: rng() < 0.3, cmcd: rng() < 0.3,
    stallCauseMs: pick(rng, [null, cms({ server: R(0, 9) })]), stallReasonMs: pick(rng, [null, { 'qoe.stall.server_wait': R(1, 9) }]),
  }))));
}

function run(i: any): unknown {
  switch (i.fn) {
    case 'classifyStall': return classifyStall(i.stall, i.ctx);
    case 'diagnose': return diagnose(i.summary, i.live);
    case 'parseSample': return parseSample(i.raw);
    case 'parsePlaybackId': return parsePlaybackId(i.raw);
    case 'parseEvents': return parseEvents(i.raw, i.now, i.sentAt);
    case 'readCmcd': return readCmcd(i.req);
    case 'readCmcdRaw': return readCmcdRaw(i.raw);
    case 'merge': return mergeSummaries(i.parts);
    case 'aggregate': {
      const a = new QoeAggregator();
      const results = i.steps.map((s: any) => {
        if (s.op === 'sample') a.addSample(s.s, s.now, s.playing);
        else if (s.op === 'event') return a.addEvent(s.e, s.now, s.opts);
        else if (s.op === 'segment') a.addSegment(s.m, s.now);
        else if (s.op === 'cmcd') a.addCmcd(s.c, s.now);
        else a.setPipeline(s.p);
        return null;
      });
      return { results, summary: a.summary(), lastStall: a.lastStall, pipeline: a.pipeline };
    }
    default: throw new Error(i.fn);
  }
}

emit('qoe', [...specInputs, ...gen], run).then(() => console.log(`qoe spec=${specCount} generated=${gen.length}`));
