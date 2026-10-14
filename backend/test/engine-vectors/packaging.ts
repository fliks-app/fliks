/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- vectors are untyped JSON */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ctlMod from '../../src/modules/streaming/streaming.controller';
import * as csMod from '../../src/modules/streaming/transcoding/codec/codec-strings';
import * as cmafMod from '../../src/modules/streaming/transcoding/cmaf-rewrite';
import * as faMod from '../../src/modules/streaming/transcoding/ffmpeg-args';
import * as mpMod from '../../src/modules/streaming/transcoding/master-playlist';
import * as raMod from '../../src/modules/streaming/transcoding/remux-assembler';
import * as sbMod from '../../src/modules/streaming/transcoding/segment-boundaries';
import * as stMod from '../../src/modules/streaming/transcoding/source-timeline';
import * as tlMod from '../../src/modules/streaming/transcoding/timeline';

/** Vectors of `core::hls` / `core::mp4`: one call each, bytes base64, bigints as strings, Maps as
 *  entries; `expected` is `{ ok }` or `{ error, code?, type }`. */

export type Kind = 'hls' | 'mp4';

export interface PVector {
  name: string;
  source: string;
  fn: string;
  args: Record<string, any>;
  expected?: unknown;
}

/** Module export -> the vector `fn` it records as. */
export const RECORDED: [Kind, Record<string, any>, string, string][] = [
  ['hls', mpMod, 'generateMasterPlaylist', 'masterPlaylist'],
  ['hls', mpMod, 'remuxBandwidthBps', 'remuxBandwidthBps'],
  ['hls', mpMod, 'pinnedRungName', 'pinnedRungName'],
  ['hls', ctlMod, 'buildVodPlaylist', 'vodPlaylist'],
  ['hls', ctlMod, 'buildVariableVodPlaylist', 'variableVodPlaylist'],
  ['hls', ctlMod, 'buildIFramePlaylist', 'iframePlaylist'],
  ['hls', csMod, 'copySourceCodecString', 'copySourceCodecString'],
  ['mp4', tlMod, 'readBoxHeader', 'readBoxHeader'],
  ['mp4', tlMod, 'findBox', 'findBox'],
  ['mp4', tlMod, 'parseInitTracks', 'parseInitTracks'],
  ['mp4', tlMod, 'rewriteSegmentTfdt', 'rewriteSegmentTfdt'],
  ['mp4', tlMod, 'readInitEdits', 'readInitEdits'],
  ['mp4', tlMod, 'withInitEdits', 'withInitEdits'],
  ['mp4', tlMod, 'retimeFragments', 'retimeFragments'],
  ['mp4', tlMod, 'firstTfdt', 'firstTfdt'],
  ['mp4', tlMod, 'readTfdt', 'readTfdt'],
  ['mp4', tlMod, 'trunSamples', 'trunSamples'],
  ['mp4', tlMod, 'videoDecodeExtent', 'videoDecodeExtent'],
  ['mp4', tlMod, 'parseTrexDefaults', 'parseTrexDefaults'],
  ['mp4', tlMod, 'makeBox', 'makeBox'],
  ['mp4', cmafMod, 'cmafRewrite', 'cmafRewrite'],
  ['mp4', cmafMod, 'isCmafRewritten', 'isCmafRewritten'],
  ['mp4', sbMod, 'computeSegmentGrid', 'computeSegmentGrid'],
  ['mp4', sbMod, 'gridSegmentIndex', 'gridSegmentIndex'],
  ['mp4', sbMod, 'remuxSegmentGrid', 'remuxSegmentGrid'],
  ['mp4', stMod, 'sourceTimeline', 'sourceTimeline'],
  ['mp4', stMod, 'inputSeekSeconds', 'inputSeekSeconds'],
  ['mp4', stMod, 'servedShift', 'servedShift'],
  ['mp4', stMod, 'servedOrigin', 'servedOrigin'],
  ['mp4', stMod, 'cueOffsetSeconds', 'cueOffsetSeconds'],
  ['mp4', faMod, 'remuxRunStart', 'remuxRunStart'],
  ['mp4', raMod, 'remuxEdits', 'remuxEdits'],
  ['mp4', raMod, 'remuxAssemblyPlan', 'remuxAssemblyPlan'],
  ['mp4', raMod, 'planBoundarySeconds', 'planBoundarySeconds'],
  ['mp4', raMod, 'gopsOf', 'gopsOf'],
  ['mp4', raMod, 'parseFrame', 'parseFrame'],
  ['mp4', raMod, 'buildFragment', 'buildFragment'],
];

/** The real functions, captured before any recording wrapper replaces an export. */
const O: Record<string, any> = Object.fromEntries(
  RECORDED.map(([, mod, exp, fn]) => [fn, mod[exp]]),
);

export const b64 = (b: Buffer): string => b.toString('base64');
const buf = (s: string): Buffer => Buffer.from(s, 'base64');
const entries = <V>(m: Map<number, V>, f: (v: V) => unknown = (v) => v) =>
  [...m].map(([k, v]) => [k, f(v)]);
const map = <V>(e: [number, V][], f: (v: any) => V = (v) => v) =>
  new Map(e.map(([k, v]) => [k, f(v)]));

/** JSON form: Buffer -> base64, bigint -> string, Map -> entries, undefined dropped. */
export function enc(x: unknown): unknown {
  if (Buffer.isBuffer(x)) return b64(x);
  if (typeof x === 'bigint') return x.toString();
  if (x instanceof Map) return [...x].map(([k, v]) => [enc(k), enc(v)]);
  if (Array.isArray(x)) return x.map(enc);
  if (x && typeof x === 'object') {
    return Object.fromEntries(
      Object.entries(x)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, enc(v)]),
    );
  }
  return x;
}

/** The segment-URL callback as the `{prefix}{NNNN}{suffix}` the engine takes. */
function segOf(url: (i: string) => string): { prefix: string; suffix: string } {
  const [prefix, suffix] = url('\u0001').split('\u0001');
  return { prefix, suffix };
}
const urlOf =
  (s: { prefix: string; suffix: string }) =>
  (i: string): string =>
    `${s.prefix}${i}${s.suffix}`;

/** Wire stream info for `sourceTimeline`: the engine's `MediaInfo` requires these keys. */
export function wireTimelineInfo(si: any): any {
  if (!si) return si ?? null;
  return {
    ...JSON.parse(JSON.stringify(si)),
    video: (si.video ?? []).map((v: any, i: number) => ({
      ...v,
      streamIndex: v?.streamIndex ?? i,
      codec: v?.codec ?? '',
    })),
    audio: [],
    subtitles: [],
  };
}

/** Call args -> vector args, per fn; `after` fills what only the call reveals. */
export const ENCODE: Record<
  string,
  (a: any[]) => { args: any; after?: () => void }
> = {
  masterPlaylist: ([o]) => ({ args: enc(o) }),
  remuxBandwidthBps: ([v, f, plans]) => ({
    args: enc({
      sourceVideoBitrateBps: v,
      formatBitRate: f,
      audioPlans: plans,
    }),
  }),
  pinnedRungName: ([q, w, h, hdr, device]) => ({
    args: {
      onlyQuality: q,
      sourceWidth: w,
      sourceHeight: h,
      hdrLadder: hdr,
      deviceType: device,
    },
  }),
  vodPlaylist: ([duration, url, init, segDuration, frameSeconds]) => ({
    args: enc({ duration, seg: segOf(url), init, segDuration, frameSeconds }),
  }),
  variableVodPlaylist: ([durations, url, init]) => ({
    args: enc({ durations, seg: segOf(url), init }),
  }),
  iframePlaylist: ([duration, url, segDuration, frameSeconds]) => ({
    args: { duration, seg: segOf(url), segDuration, frameSeconds },
  }),
  copySourceCodecString: ([video]) => ({ args: enc({ video }) }),
  readBoxHeader: ([b, off, start, end]) => ({
    args: { buf: b64(b), off, start, end },
  }),
  findBox: ([b, start, end, type]) => ({
    args: { buf: b64(b), start, end, type },
  }),
  parseInitTracks: ([init]) => ({ args: { init: b64(init) } }),
  rewriteSegmentTfdt: ([seg, tracks, segIndex, segDuration, startPts]) => ({
    args: enc({ seg, tracks, segIndex, segDuration, startPts }),
  }),
  readInitEdits: ([init]) => ({ args: { init: b64(init) } }),
  withInitEdits: (a) => {
    const args: any = { init: b64(a[0]), seconds: [] };
    const seen = new Map<number, number>();
    const f = a[1];
    a[1] = (id: number, t: unknown) => {
      const s = f(id, t);
      seen.set(id, s);
      return s;
    };
    return { args, after: () => (args.seconds = [...seen]) };
  },
  retimeFragments: ([seg, deltas]) => ({ args: enc({ seg, deltas }) }),
  firstTfdt: ([seg, trackId]) => ({ args: { seg: b64(seg), trackId } }),
  readTfdt: ([b, traf]) => ({ args: { buf: b64(b), traf: enc(traf) } }),
  trunSamples: ([b, traf, trexDefault]) => ({
    args: enc({ buf: b, traf, trexDefault: trexDefault ?? 0 }),
  }),
  videoDecodeExtent: ([moofs, trackId, trexDefault]) => ({
    args: { moofs: b64(moofs), trackId, trexDefault: trexDefault ?? 0 },
  }),
  parseTrexDefaults: ([init]) => ({ args: { init: b64(init) } }),
  makeBox: ([type, children]) => ({
    args: { type, children: children.map(b64) },
  }),
  cmafRewrite: ([b]) => ({ args: { buf: b64(b) } }),
  isCmafRewritten: ([b]) => ({ args: { buf: b64(b) } }),
  computeSegmentGrid: ([keyframes, origin, end, segDur, frameSeconds]) => ({
    args: enc({ keyframes, origin, end, segDur, frameSeconds }),
  }),
  gridSegmentIndex: ([boundaries, seconds, origin]) => ({
    args: { boundaries, seconds, origin },
  }),
  remuxSegmentGrid: ([scan, origin, segDur, frameRate]) => ({
    args: enc({
      scan: scan ? { keyframes: scan.keyframes, end: scan.end } : null,
      origin,
      segDur,
      frameRate,
    }),
  }),
  sourceTimeline: ([si]) => ({ args: { si: wireTimelineInfo(si) } }),
  inputSeekSeconds: ([contentSeconds, timeline]) => ({
    args: enc({ contentSeconds, timeline }),
  }),
  servedShift: ([timeline]) => ({
    args: enc({ timeline: { origin: timeline.origin } }),
  }),
  servedOrigin: ([timeline]) => ({
    args: enc({ timeline: { origin: timeline.origin } }),
  }),
  cueOffsetSeconds: ([timeline]) => ({ args: enc({ timeline }) }),
  remuxRunStart: ([
    grid,
    startSegment,
    segmentDuration,
    origin,
    audioGrid,
  ]) => ({
    args: enc({
      grid: grid ?? null,
      startSegment,
      segmentDuration,
      origin,
      audioGrid: audioGrid ?? null,
    }),
  }),
  remuxEdits: ([start, firstDecode]) => ({ args: { start, firstDecode } }),
  remuxAssemblyPlan: ([o]) => ({
    args: enc({
      grid: o.grid ?? null,
      startSegment: o.startSegment,
      run: o.run,
      origin: o.origin,
      segmentDuration: o.segmentDuration,
      audioRenditions: o.audioRenditions,
    }),
  }),
  planBoundarySeconds: ([plan, i]) => ({
    args: enc({ plan: planOf(plan), i }),
  }),
  gopsOf: ([plan, segment]) => ({ args: enc({ plan: planOf(plan), segment }) }),
  parseFrame: ([moof, mdat]) => ({
    args: { moof: b64(moof), mdat: b64(mdat) },
  }),
  buildFragment: ([trackId, sequenceNumber, tfdt, samples, data]) => ({
    args: enc({ trackId, sequenceNumber, tfdt, samples, data }),
  }),
};

/** A plan without the session and GOP dirs, which stay with the caller. */
function planOf(p: any): any {
  const rest = { ...p };
  delete rest.dir;
  delete rest.gopDir;
  return rest;
}

const planIn = (p: any) => ({ dir: '/s', gopDir: '/s/g', ...p });

const RUN: Record<string, (a: any) => unknown> = {
  masterPlaylist: (a) => O.masterPlaylist(a),
  remuxBandwidthBps: (a) =>
    O.remuxBandwidthBps(a.sourceVideoBitrateBps, a.formatBitRate, a.audioPlans),
  pinnedRungName: (a) =>
    O.pinnedRungName(
      a.onlyQuality,
      a.sourceWidth,
      a.sourceHeight,
      a.hdrLadder,
      a.deviceType,
    ),
  vodPlaylist: (a) =>
    O.vodPlaylist(
      a.duration,
      urlOf(a.seg),
      a.init,
      a.segDuration,
      a.frameSeconds,
    ),
  variableVodPlaylist: (a) =>
    O.variableVodPlaylist(a.durations, urlOf(a.seg), a.init),
  iframePlaylist: (a) =>
    O.iframePlaylist(a.duration, urlOf(a.seg), a.segDuration, a.frameSeconds),
  copySourceCodecString: (a) => O.copySourceCodecString(a.video),
  readBoxHeader: (a) => O.readBoxHeader(buf(a.buf), a.off, a.start, a.end),
  findBox: (a) => O.findBox(buf(a.buf), a.start, a.end, a.type),
  parseInitTracks: (a) => O.parseInitTracks(buf(a.init)),
  rewriteSegmentTfdt: (a) =>
    O.rewriteSegmentTfdt(
      buf(a.seg),
      map(a.tracks),
      a.segIndex,
      a.segDuration,
      a.startPts,
    ),
  readInitEdits: (a) => O.readInitEdits(buf(a.init)),
  withInitEdits: (a) => {
    const s = new Map<number, number>(a.seconds);
    return O.withInitEdits(buf(a.init), (id: number) => s.get(id));
  },
  retimeFragments: (a) => O.retimeFragments(buf(a.seg), map(a.deltas, BigInt)),
  firstTfdt: (a) => O.firstTfdt(buf(a.seg), a.trackId),
  readTfdt: (a) => O.readTfdt(buf(a.buf), a.traf),
  trunSamples: (a) => O.trunSamples(buf(a.buf), a.traf, a.trexDefault),
  videoDecodeExtent: (a) =>
    O.videoDecodeExtent(buf(a.moofs), a.trackId, a.trexDefault),
  parseTrexDefaults: (a) => O.parseTrexDefaults(buf(a.init)),
  makeBox: (a) => O.makeBox(a.type, a.children.map(buf)),
  cmafRewrite: (a) => O.cmafRewrite(buf(a.buf)),
  isCmafRewritten: (a) => O.isCmafRewritten(buf(a.buf)),
  readAndRewriteCmaf: async (a) => {
    const dir = mkdtempSync(join(tmpdir(), 'cmaf-'));
    try {
      writeFileSync(join(dir, 'f'), buf(a.buf));
      return await cmafMod.readAndRewriteCmaf(join(dir, 'f'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  computeSegmentGrid: (a) =>
    a.frameSeconds === undefined
      ? O.computeSegmentGrid(a.keyframes, a.origin, a.end, a.segDur)
      : O.computeSegmentGrid(
          a.keyframes,
          a.origin,
          a.end,
          a.segDur,
          a.frameSeconds,
        ),
  gridSegmentIndex: (a) =>
    O.gridSegmentIndex(a.boundaries, a.seconds, a.origin),
  remuxSegmentGrid: (a) =>
    O.remuxSegmentGrid(a.scan, a.origin, a.segDur, a.frameRate),
  sourceTimeline: (a) => O.sourceTimeline(a.si, 'vector'),
  inputSeekSeconds: (a) => O.inputSeekSeconds(a.contentSeconds, a.timeline),
  servedShift: (a) => O.servedShift(a.timeline),
  servedOrigin: (a) => O.servedOrigin(a.timeline),
  cueOffsetSeconds: (a) => O.cueOffsetSeconds(a.timeline),
  remuxRunStart: (a) =>
    O.remuxRunStart(
      a.grid,
      a.startSegment,
      a.segmentDuration,
      a.origin,
      a.audioGrid,
    ),
  remuxEdits: (a) => O.remuxEdits(a.start, a.firstDecode),
  remuxAssemblyPlan: (a) =>
    planOf(
      O.remuxAssemblyPlan({
        dir: '/s',
        gopDir: '/s/g',
        grid: a.grid,
        startSegment: a.startSegment,
        run: a.run,
        origin: a.origin,
        segmentDuration: a.segmentDuration,
        audioRenditions: a.audioRenditions,
      }),
    ),
  planBoundarySeconds: (a) => O.planBoundarySeconds(planIn(a.plan), a.i),
  gopsOf: (a) => O.gopsOf(planIn(a.plan), a.segment),
  parseFrame: (a) => O.parseFrame(buf(a.moof), buf(a.mdat)),
  buildFragment: (a) =>
    O.buildFragment(
      a.trackId,
      a.sequenceNumber,
      BigInt(a.tfdt),
      a.samples,
      a.data.map(buf),
    ),
  variantRoute: (a) =>
    route('hlsPlaylist', [a.mediaFileId, a.quality], a, {
      duration: a.durationHint,
    }),
  audioRoute: (a) =>
    route('hlsAudioPlaylist', [a.mediaFileId, a.audioIndex], a, {}),
  iframeRoute: (a) =>
    route('iframePlaylist', [a.mediaFileId], a, { duration: a.durationHint }),
  subtitleRoute: (a) =>
    a.kind === 'embedded'
      ? route('embeddedSubtitlePlaylist', [a.mediaFileId, a.key], a, {})
      : route('externalSubtitlePlaylist', [a.mediaFileId, a.key], a, {}),
};

/** A playlist route of the real controller, its collaborators answering from the vector. */
async function route(
  method: string,
  params: unknown[],
  a: any,
  query: Record<string, string | undefined>,
): Promise<string> {
  const ctl = Object.create(ctlMod.StreamingController.prototype);
  Object.assign(ctl, {
    sessionRouter: {
      assertFresh: () => undefined,
      findRequestSession: () => a.live ?? undefined,
      resolveSession: () => null,
    },
    streamingService: {
      resolveFile: () =>
        Promise.resolve({
          mediaFile: {
            id: a.mediaFileId,
            streamInfo: {
              durationSeconds: a.durationSeconds,
              video: a.frameRate ? [{ frameRate: a.frameRate }] : [],
            },
          },
        }),
    },
    activeStreamTracker: { getSegmentDuration: () => a.segmentDuration },
    resolveDuration: () => Promise.resolve(a.resolvedDuration),
  });
  let body = '';
  let status = 200;
  const res = {
    setHeader: () => res,
    status: (s: number) => {
      status = s;
      return res;
    },
    send: (b: string) => {
      body = b;
    },
  };
  const req = { query: { ...query, token: a.token, sid: a.sid }, user: {} };
  await ctl[method](...params, req, res);
  if (status !== 200) throw new Error(`status ${status}: ${body}`);
  return body;
}

export const kindOf = (fn: string): Kind =>
  fn.endsWith('Route') || RECORDED.some(([k, , , f]) => f === fn && k === 'hls')
    ? 'hls'
    : 'mp4';

/** `{ ok }` or `{ error, code? }`. */
export async function runP(v: Pick<PVector, 'fn' | 'args'>): Promise<unknown> {
  const run = RUN[v.fn];
  if (!run) throw new Error(`unknown vector fn ${v.fn}`);
  try {
    return { ok: enc(await run(JSON.parse(JSON.stringify(v.args)))) ?? null };
  } catch (e) {
    const err = e as Error & { code?: string };
    return enc({
      error: err.message,
      code: err.code,
      type: err.constructor.name,
    });
  }
}

/** Only these errors have a counterpart in the port; others are inputs the TS cannot take. */
export const portedError = (x: any): boolean =>
  !x?.error ||
  x.type === 'RangeError' ||
  (x.type === 'Error' && !x.error.startsWith('status '));

export { entries, map };
