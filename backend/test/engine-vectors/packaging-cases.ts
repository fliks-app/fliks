/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- vectors are untyped JSON */
import { computeSegmentGrid } from '../../src/modules/streaming/transcoding/segment-boundaries';
import { b64, enc, wireTimelineInfo, type PVector } from './packaging';

// ── ISO-BMFF builders ──────────────────────────────────────────────────────

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const u64 = (n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt.asIntN(64, n));
  return b;
};
const box = (type: string, ...children: Buffer[]): Buffer => {
  const body = Buffer.concat(children);
  return Buffer.concat([
    u32(8 + body.length),
    Buffer.from(type, 'latin1'),
    body,
  ]);
};
const full = (v: number, flags = 0) => u32((v << 24) | flags);

interface TrakOpts {
  id: number;
  ts: number;
  handler?: string;
  v1?: boolean;
  /** `[duration, mediaTime]` per edit; absent = no edts. */
  edits?: [number, number][];
  editsV1?: boolean;
}

export function trak(o: TrakOpts): Buffer {
  const times = o.v1 ? Buffer.alloc(16) : Buffer.alloc(8);
  const tkhd = box(
    'tkhd',
    full(o.v1 ? 1 : 0),
    times,
    u32(o.id),
    Buffer.alloc(8),
  );
  const mdhd = box(
    'mdhd',
    full(o.v1 ? 1 : 0),
    times,
    u32(o.ts),
    Buffer.alloc(4),
  );
  const hdlr = box(
    'hdlr',
    Buffer.alloc(8),
    Buffer.from(o.handler ?? 'vide', 'latin1'),
    Buffer.alloc(12),
  );
  const parts = [tkhd];
  if (o.edits) {
    const entries = o.edits.map(([d, m]) =>
      o.editsV1
        ? Buffer.concat([u64(BigInt(d)), u64(BigInt(m)), u32(0x10000)])
        : Buffer.concat([u32(d), u32(m), u32(0x10000)]),
    );
    parts.push(
      box(
        'edts',
        box('elst', full(o.editsV1 ? 1 : 0), u32(o.edits.length), ...entries),
      ),
    );
  }
  parts.push(box('mdia', mdhd, hdlr));
  return box('trak', ...parts);
}

export function init(
  traks: TrakOpts[],
  o: { movieTs?: number; trex?: [number, number][]; ftyp?: boolean } = {},
): Buffer {
  const parts: Buffer[] = [];
  if (o.movieTs !== undefined)
    parts.push(
      box('mvhd', full(0), Buffer.alloc(8), u32(o.movieTs), Buffer.alloc(4)),
    );
  parts.push(...traks.map(trak));
  if (o.trex) {
    parts.push(
      box(
        'mvex',
        ...o.trex.map(([id, d]) =>
          box('trex', full(0), u32(id), u32(1), u32(d), u32(0), u32(0)),
        ),
      ),
    );
  }
  const moov = box('moov', ...parts);
  return o.ftyp === false
    ? moov
    : Buffer.concat([ftyp(['iso5', 'iso6', 'mp41']), moov]);
}

export const ftyp = (compat: string[], major = 'iso5') =>
  box(
    'ftyp',
    Buffer.from(major, 'latin1'),
    u32(512),
    ...compat.map((c) => Buffer.from(c, 'latin1')),
  );

interface Sample {
  duration?: number;
  size?: number;
  flags?: number;
  cts?: number;
}

interface TrafOpts {
  id: number;
  tfdt?: bigint;
  tfdtV1?: boolean;
  /** tfhd defaults (flags 0x8/0x10/0x20) and skipped fields (0x1/0x2). */
  defaults?: {
    duration?: number;
    size?: number;
    flags?: number;
    base?: boolean;
    desc?: boolean;
  };
  samples?: Sample[];
  /** trun per-sample field flags; default duration+size. */
  trunFlags?: number;
  firstFlags?: number;
}

export function traf(o: TrafOpts): Buffer {
  const d = o.defaults ?? {};
  const fields: [unknown, number, () => Buffer][] = [
    [d.base, 0x1, () => Buffer.alloc(8)],
    [d.desc, 0x2, () => u32(1)],
    [d.duration !== undefined, 0x8, () => u32(d.duration!)],
    [d.size !== undefined, 0x10, () => u32(d.size!)],
    [d.flags !== undefined, 0x20, () => u32(d.flags!)],
  ];
  const on = fields.filter(([set]) => set);
  const tf = on.reduce((f, [, bit]) => f | bit, 0);
  const tfParts = on.map(([, , b]) => b());
  const parts = [box('tfhd', full(0, tf), u32(o.id), ...tfParts)];
  if (o.tfdt !== undefined) {
    parts.push(
      box(
        'tfdt',
        full(o.tfdtV1 ? 1 : 0),
        o.tfdtV1 ? u64(o.tfdt) : u32(Number(o.tfdt)),
      ),
    );
  }
  if (o.samples) {
    let flags = o.trunFlags ?? 0x300;
    flags |= 0x1;
    if (o.firstFlags !== undefined) flags |= 0x4;
    const s = [
      full(o.samples.some((x) => (x.cts ?? 0) < 0) ? 1 : 0, flags),
      u32(o.samples.length),
      u32(0),
    ];
    if (o.firstFlags !== undefined) s.push(u32(o.firstFlags));
    for (const x of o.samples) {
      if (flags & 0x100) s.push(u32(x.duration ?? 0));
      if (flags & 0x200) s.push(u32(x.size ?? 0));
      if (flags & 0x400) s.push(u32(x.flags ?? 0));
      if (flags & 0x800) s.push(u32(x.cts ?? 0));
    }
    parts.push(box('trun', ...s));
  }
  return box('traf', ...parts);
}

export const moof = (seq: number, ...trafs: Buffer[]) =>
  box('moof', box('mfhd', full(0), u32(seq)), ...trafs);
export const mdat = (n: number, fill = 0) => box('mdat', Buffer.alloc(n, fill));
export const styp = () =>
  box(
    'styp',
    Buffer.from('msdh', 'latin1'),
    u32(0),
    Buffer.from('msdhmsix', 'latin1'),
  );
export const sidx = () => box('sidx', full(1), Buffer.alloc(24));

/** The box at `off` of `b`, as the TS `Box`. */
function boxAt(b: Buffer, off: number, type: string): any {
  const i = b.indexOf(type, off, 'latin1');
  if (i < 4) return null;
  return {
    type,
    start: i - 4,
    size: b.readUInt32BE(i - 4),
    payloadStart: i + 4,
  };
}

// ── random helpers ──────────────────────────────────────────────────────────

export type Rng = () => number;
const int = (r: Rng, lo: number, hi: number) =>
  lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rng, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)];
const chance = (r: Rng, p: number) => r() < p;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

// ── HLS ─────────────────────────────────────────────────────────────────────

const SIZES: [number, number][] = [
  [3840, 2160],
  [1920, 1080],
  [1918, 872],
  [1280, 720],
  [854, 480],
  [640, 360],
  [426, 240],
  [256, 144],
  [720, 576],
  [1440, 1080],
  [4096, 1716],
  [3840, 1600],
];
const FPS = [24, 23.976, 25, 29.97, 30, 50, 59.94, 60, 24000 / 1001, 119.88];
const SDR = [
  { codec: 'h264', bitDepth: 8, hdr: null },
  { codec: 'hevc', bitDepth: 8, hdr: null },
  { codec: 'av1', bitDepth: 8, hdr: null },
];
const HDR = [
  { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' },
  { codec: 'hevc', bitDepth: 10, hdr: 'HLG' },
  { codec: 'av1', bitDepth: 10, hdr: 'HDR10' },
];
const PINS = [
  '1080p',
  '720p',
  'eco-2160p',
  'eco-1080p',
  '2160p-hdr',
  '480p',
  'remux',
  'original',
  '1440p',
  'eco-480p',
  'foo',
  '0p',
  '4320p',
  '144p',
];
const LANGS = ['eng', 'fre', 'und', 'spa', '', 'jpn'];
const TITLES = [undefined, '', 'English', 'Commentary', 'Director', 'English'];

function plan(r: Rng): any {
  if (chance(r, 0.5)) {
    return {
      mode: 'transcode',
      codec: pick(r, ['aac', 'ac3', 'eac3', 'opus']),
      channels: pick(r, [1, 2, 6, 8]),
    };
  }
  return enc({
    mode: 'copy',
    codec: pick(r, [
      'aac',
      'ac3',
      'eac3',
      'opus',
      'flac',
      'truehd',
      'dts',
      'mp3',
      'AAC',
    ]),
    channels: chance(r, 0.8) ? pick(r, [1, 2, 6, 8]) : undefined,
    bitrateBps: chance(r, 0.5)
      ? pick(r, [96000, 128000, 640000, 768000, 0])
      : undefined,
    profile: chance(r, 0.4)
      ? pick(r, [
          'LC',
          'HE-AAC',
          'HE-AACv2',
          'Dolby Digital Plus + Dolby Atmos',
          'atmos',
        ])
      : undefined,
  });
}

function audioStream(r: Rng): any {
  return enc({
    language: chance(r, 0.85) ? pick(r, LANGS) : undefined,
    languageTag: chance(r, 0.2) ? pick(r, ['es-419', 'en-US', '']) : undefined,
    title: pick(r, TITLES),
    channels: chance(r, 0.8) ? pick(r, [0, 1, 2, 6, 8]) : undefined,
  });
}

export function randomMaster(r: Rng): any {
  const [w, h] = chance(r, 0.85)
    ? pick(r, SIZES)
    : [int(r, 0, 4200), int(r, 0, 2400)];
  const layout = pick(r, ['muxed', 'multi', 'none', 'muxed']);
  const n = layout === 'multi' ? int(r, 1, 4) : 0;
  const o: any = {
    mediaFileId: int(r, 1, 999),
    sourceWidth: w,
    sourceHeight: h,
    tokenParam: pick(r, ['', '?token=abc', '?token=t&sid=s1']),
    includeRemux: chance(r, 0.25),
    sourceFrameRate: chance(r, 0.9) ? pick(r, FPS) : undefined,
    deviceType: pick(r, ['desktop', 'mobile']),
  };
  if (layout === 'multi')
    o.audioStreams = Array.from({ length: n }, () => audioStream(r));
  if (layout === 'none') o.audioStreams = [];
  if (layout === 'muxed' && chance(r, 0.5)) o.muxedAudio = audioStream(r);
  if (chance(r, 0.8))
    o.audioPlans = Array.from({ length: Math.max(1, n || int(r, 0, 1)) }, () =>
      plan(r),
    );
  if (chance(r, 0.3)) o.onlyQuality = pick(r, PINS);
  if (chance(r, 0.3)) o.defaultAudioIndex = int(r, -1, 4);
  if (chance(r, 0.3)) o.supportsAbr = chance(r, 0.5);
  if (chance(r, 0.2)) o.dedupesAudioByLanguage = true;
  if (chance(r, 0.35)) {
    const hdrVariant = pick(r, HDR);
    o.hdrPassThrough = { hdrFormat: hdrVariant.hdr, hdrVariant };
    o.canEmitHdrLadder = chance(r, 0.8);
  }
  if (chance(r, 0.6)) o.sdrVariant = pick(r, SDR);
  if (chance(r, 0.6))
    o.sourceVideoBitrateBps = pick(
      r,
      [100_000_000, 2_000_000, 25_000_000, 800_000, 5_123_457.5],
    );
  if (chance(r, 0.6))
    o.sourceVideoCodec = pick(r, [
      'h264',
      'hevc',
      'av1',
      'vp9',
      'mpeg2video',
      'HEVC',
    ]);
  if (o.includeRemux) {
    if (chance(r, 0.6))
      o.remuxCodecs = pick(r, ['avc1.640029', 'hvc1.2.4.L153.B0', '', null]);
    if (chance(r, 0.3))
      o.remuxSupplementalCodecs = pick(r, ['dvh1.08.06/db4h', null]);
    if (chance(r, 0.5)) o.formatBitRate = pick(r, [0, 12_000_000, 7_999_999.6]);
    if (chance(r, 0.4)) o.sourceHdrFormat = pick(r, ['HDR10', 'HLG']);
    if (chance(r, 0.5)) {
      o.remuxWidth = w + int(r, 0, 2) * 2;
      o.remuxHeight = h + int(r, 0, 140);
    }
  }
  if (chance(r, 0.35)) {
    o.subtitleRenditions = Array.from({ length: int(r, 1, 4) }, () =>
      enc({
        kind: pick(r, ['embedded', 'external']),
        key: int(r, 0, 40),
        language: chance(r, 0.8) ? pick(r, LANGS) : undefined,
        languageTag: chance(r, 0.2) ? 'pt-BR' : undefined,
        name: pick(r, ['English', 'English', 'Français', '', 'Forced']),
        forced: chance(r, 0.5) ? chance(r, 0.5) : undefined,
      }),
    );
  }
  if (chance(r, 0.3))
    o.iFrameTrickPlaySegmentSeconds = pick(r, [3, 3.003, 0.5, 6, 2.002]);
  return o;
}

function seg(r: Rng): { prefix: string; suffix: string } {
  return pick(r, [
    { prefix: '/api/stream/7/1080p/seg-', suffix: '.m4s?token=x' },
    { prefix: 'iframe/seg-', suffix: '.ts' },
    { prefix: '', suffix: '' },
  ]);
}

const DURATIONS = [
  0.5,
  3,
  12,
  25,
  120.001,
  120.04,
  90.09 + 1 / 23.976,
  1795.3,
  5400.04,
  7322.123456,
];

export function randomHls(r: Rng, i: number): PVector {
  const fn = pick(r, [
    'masterPlaylist',
    'masterPlaylist',
    'masterPlaylist',
    'vodPlaylist',
    'variableVodPlaylist',
    'iframePlaylist',
    'variantRoute',
    'audioRoute',
    'iframeRoute',
    'subtitleRoute',
    'remuxBandwidthBps',
    'pinnedRungName',
    'copySourceCodecString',
  ]);
  const fps = chance(r, 0.8) ? pick(r, FPS) : undefined;
  const segDuration = pick(r, [3, 3.003, 6, 2, 4, 1.5, 10]);
  const duration = chance(r, 0.7)
    ? pick(r, DURATIONS)
    : round3(r() * 600 + 0.001);
  const frameSeconds = 1 / (fps ?? 24);
  let args: any;
  switch (fn) {
    case 'masterPlaylist':
      args = randomMaster(r);
      break;
    case 'vodPlaylist':
      args = enc({
        duration,
        seg: seg(r),
        init: chance(r, 0.5) ? 'init.mp4' : undefined,
        segDuration,
        frameSeconds,
      });
      break;
    case 'iframePlaylist':
      args = { duration, seg: seg(r), segDuration, frameSeconds };
      break;
    case 'variableVodPlaylist':
      args = enc({
        durations: Array.from({ length: int(r, 0, 30) }, () =>
          round3(r() * 8 + 0.04),
        ),
        seg: seg(r),
        init: chance(r, 0.5) ? 'init_0.mp4' : undefined,
      });
      break;
    case 'remuxBandwidthBps':
      args = enc({
        sourceVideoBitrateBps: chance(r, 0.6) ? r() * 4e7 : undefined,
        formatBitRate: chance(r, 0.5) ? r() * 4e7 : undefined,
        audioPlans: Array.from({ length: int(r, 0, 3) }, () => plan(r)),
      });
      break;
    case 'pinnedRungName': {
      const [w, h] = pick(r, SIZES);
      args = {
        onlyQuality: pick(r, PINS),
        sourceWidth: w,
        sourceHeight: h,
        hdrLadder: chance(r, 0.4),
        deviceType: 'desktop',
      };
      break;
    }
    case 'copySourceCodecString':
      args = {
        video: enc({
          codec: pick(r, [
            'h264',
            'hevc',
            'av1',
            'avc1',
            'h265',
            'vp9',
            '',
            'HEVC',
          ]),
          profile: pick(r, [
            'High',
            'Main',
            'Main 10',
            'main',
            'high 10',
            'Constrained Baseline',
            'Professional',
            'Rext',
            '',
            undefined,
          ]),
          level: pick(r, [41, 40, 120, 153, 8, 13, 31, 0, -99, 256, 29, 30]),
          bitDepth: chance(r, 0.5) ? pick(r, [8, 10, 12, 9]) : undefined,
          pixelFormat: chance(r, 0.6)
            ? pick(r, ['yuv420p', 'yuv420p10le', 'yuv420p12le', ''])
            : undefined,
        }),
      };
      break;
    default:
      args = routeArgs(r, fn, duration, segDuration, fps);
  }
  return { name: `fuzz ${fn} ${i}`, source: 'fuzz', fn, args };
}

const QUALITIES = ['1080p', '720p', '2160p-hdr', 'eco-720p', 'remux', '480p'];

function routeArgs(
  r: Rng,
  fn: string,
  duration: number,
  segmentDuration: number,
  fps: number | undefined,
): any {
  const grid = computeSegmentGrid(
    Array.from({ length: int(r, 1, 12) }, (_, k) => ({
      pts: k * 2.5 + r() * 2,
      dts: k * 2.5,
    })),
    0,
    duration,
    segmentDuration,
  );
  const live = chance(r, 0.2)
    ? null
    : enc({
        useTs: chance(r, 0.3),
        useExtXMedia: chance(r, 0.4),
        kind: pick(r, ['remux', 'transcode']),
        remuxGrid: chance(r, 0.5)
          ? { durations: grid?.durations ?? [] }
          : chance(r, 0.5)
            ? null
            : undefined,
        sourceFps: chance(r, 0.5) ? fps : undefined,
      });
  const base: any = enc({
    mediaFileId: int(r, 1, 999),
    token: chance(r, 0.5) ? 'tok' : undefined,
    sid: chance(r, 0.4) ? 'sid9' : undefined,
    resolvedDuration: duration,
    live,
    frameRate: chance(r, 0.7)
      ? pick(r, ['24000/1001', '25', '23.976', '60', '0/0', 'abc'])
      : undefined,
    segmentDuration,
  });
  if (fn === 'variantRoute') {
    base.quality = pick(r, QUALITIES);
    if (chance(r, 0.4)) base.durationHint = String(round3(duration + 1));
  } else if (fn === 'audioRoute') {
    base.audioIndex = int(r, 0, 5);
  } else if (fn === 'iframeRoute') {
    if (chance(r, 0.4)) base.durationHint = String(duration);
  } else {
    base.kind = pick(r, ['embedded', 'external']);
    base.key = int(r, 0, 99);
    if (chance(r, 0.8))
      base.durationSeconds = pick(r, [0, 0.4, 1, 125.25, 5400.04]);
  }
  return base;
}

// ── MP4 ─────────────────────────────────────────────────────────────────────

function randomTraks(r: Rng): TrakOpts[] {
  return Array.from({ length: int(r, 1, 3) }, (_, k) => ({
    id: chance(r, 0.9) ? k + 1 : int(r, 1, 3),
    ts: pick(r, [1000, 90000, 48000, 44100, 12800, 15360, 0, 24000]),
    handler:
      k === 0
        ? pick(r, ['vide', 'vide', 'soun'])
        : pick(r, ['soun', 'subt', 'vide']),
    v1: chance(r, 0.3),
    edits: chance(r, 0.6)
      ? Array.from({ length: int(r, 1, 3) }, () => [
          int(r, 0, 5000),
          pick(r, [-1, 0, 1024, 2048, 3003, -1, 0x7fffffff]),
        ])
      : undefined,
    editsV1: chance(r, 0.3),
  }));
}

function randomFrags(r: Rng, ids: number[]): Buffer {
  const parts: Buffer[] = [];
  if (chance(r, 0.3)) parts.push(styp());
  if (chance(r, 0.2)) parts.push(sidx());
  for (let m = 0, n = int(r, 1, 3); m < n; m++) {
    const trafs = ids.slice(0, int(r, 1, ids.length)).map((id) => {
      const v1 = chance(r, 0.5);
      const tfdt = v1
        ? BigInt(int(r, -5000, 9_000_000)) * BigInt(pick(r, [1, 1, 1000]))
        : BigInt(int(r, 0, 4_000_000));
      return traf({
        id: chance(r, 0.9) ? id : 77,
        tfdt: chance(r, 0.95) ? tfdt : undefined,
        tfdtV1: v1,
        defaults: chance(r, 0.4)
          ? {
              duration: int(r, 0, 3000),
              size: chance(r, 0.5) ? 100 : undefined,
              flags: chance(r, 0.5) ? 0x2000000 : undefined,
              base: chance(r, 0.3),
              desc: chance(r, 0.3),
            }
          : undefined,
        samples: chance(r, 0.8)
          ? Array.from({ length: int(r, 0, 5) }, () => ({
              duration: int(r, 0, 4000),
              size: int(r, 0, 900),
              flags: int(r, 0, 0x3000000),
              cts: int(r, -2000, 4000),
            }))
          : undefined,
        trunFlags: pick(r, [0x300, 0x100, 0xf00, 0x0, 0x700, 0xb00]),
        firstFlags: chance(r, 0.3) ? 0x2000000 : undefined,
      });
    });
    parts.push(moof(m + 1, ...trafs), mdat(int(r, 0, 16)));
  }
  return Buffer.concat(parts);
}

/** Corrupt the tail or one box size; inner count fields stay, so the TS never loops forever. */
function damage(r: Rng, b: Buffer): Buffer {
  if (chance(r, 0.75)) return b;
  if (chance(r, 0.5)) return b.subarray(0, int(r, 0, b.length));
  const c = Buffer.from(b);
  const i = c.indexOf(
    pick(r, ['moof', 'traf', 'trak', 'mdia', 'tfdt', 'moov', 'edts']),
    0,
    'latin1',
  );
  if (i >= 4)
    c.writeUInt32BE(
      pick(r, [
        0,
        1,
        4,
        7,
        9,
        c.length + 5,
        Math.max(0, c.readUInt32BE(i - 4) - 4),
      ]),
      i - 4,
    );
  return c;
}

export function randomMp4(r: Rng, i: number): PVector {
  const fn = pick(r, [
    'rewriteSegmentTfdt',
    'rewriteSegmentTfdt',
    'parseInitTracks',
    'readInitEdits',
    'withInitEdits',
    'retimeFragments',
    'firstTfdt',
    'trunSamples',
    'videoDecodeExtent',
    'parseTrexDefaults',
    'cmafRewrite',
    'isCmafRewritten',
    'readBoxHeader',
    'computeSegmentGrid',
    'computeSegmentGrid',
    'gridSegmentIndex',
    'sourceTimeline',
    'remuxRunStart',
    'remuxRunStart',
    'remuxAssemblyPlan',
    'planBoundarySeconds',
    'gopsOf',
    'parseFrame',
    'buildFragment',
    'inputSeekSeconds',
    'cueOffsetSeconds',
    'remuxEdits',
  ]);
  const traks = randomTraks(r);
  const ids = [...new Set(traks.map((t) => t.id))];
  const initBuf = () =>
    damage(
      r,
      init(traks, {
        movieTs: chance(r, 0.8) ? pick(r, [1000, 600, 0]) : undefined,
        trex: chance(r, 0.5)
          ? ids.map((id) => [id, int(r, 0, 2000)])
          : undefined,
        ftyp: chance(r, 0.7),
      }),
    );
  const segBuf = () => damage(r, randomFrags(r, ids));
  const tracks = () =>
    ids.map((id) => [
      id,
      { timescale: pick(r, [1000, 90000, 48000, 0]), isVideo: chance(r, 0.5) },
    ]);
  let args: any;
  switch (fn) {
    case 'rewriteSegmentTfdt':
      args = {
        seg: b64(segBuf()),
        tracks: chance(r, 0.9) ? tracks() : [],
        segIndex: int(r, 0, 3000),
        segDuration: pick(r, [3, 3.003, 6, 0.5]),
        startPts: pick(r, [0, 1.4, -23.717689, 0.08, 2.8]),
      };
      break;
    case 'parseInitTracks':
    case 'readInitEdits':
    case 'parseTrexDefaults':
      args = { init: b64(initBuf()) };
      break;
    case 'withInitEdits':
      args = {
        init: b64(initBuf()),
        seconds: ids.map((id) => [
          id,
          pick(r, [0, 0.01, 0.128, -0.05, 2.5, 30000, -1e6]),
        ]),
      };
      break;
    case 'retimeFragments':
      args = {
        seg: b64(segBuf()),
        deltas: ids
          .filter(() => chance(r, 0.9))
          .map((id) => [id, String(int(r, -100000, 100000000))]),
      };
      break;
    case 'firstTfdt':
      args = { seg: b64(segBuf()), trackId: pick(r, [...ids, 9]) };
      break;
    case 'videoDecodeExtent': {
      const s = segBuf();
      args = {
        moofs: b64(s),
        trackId: pick(r, [...ids, 9]),
        trexDefault: int(r, 0, 1001),
      };
      break;
    }
    case 'trunSamples': {
      const s = randomFrags(r, ids);
      args = {
        buf: b64(s),
        traf: boxAt(s, 0, 'traf'),
        trexDefault: int(r, 0, 1024),
      };
      if (!args.traf)
        args.traf = { type: 'traf', start: 0, size: s.length, payloadStart: 8 };
      break;
    }
    case 'cmafRewrite':
    case 'isCmafRewritten': {
      const parts = [
        chance(r, 0.5)
          ? ftyp(chance(r, 0.3) ? ['iso5', 'hlsf'] : ['iso5', 'iso6', 'mp41'])
          : styp(),
      ];
      parts.push(segBuf());
      args = { buf: b64(damage(r, Buffer.concat(parts))) };
      break;
    }
    case 'readBoxHeader': {
      const b = damage(
        r,
        Buffer.concat([
          chance(r, 0.3)
            ? box('free', u32(1), u64(BigInt(int(r, 0, 64))))
            : mdat(int(r, 0, 20)),
          mdat(4),
        ]),
      );
      const off = int(r, 0, Math.max(0, b.length - 1));
      args = { buf: b64(b), off, start: off, end: int(r, off, b.length + 4) };
      break;
    }
    case 'parseFrame': {
      const fr = moof(
        1,
        traf({
          id: 2,
          tfdt: BigInt(int(r, 0, 1e6)),
          tfdtV1: chance(r, 0.7),
          samples: Array.from({ length: pick(r, [1, 1, 1, 0, 2]) }, () => ({
            duration: 1024,
            size: int(r, 1, 400),
            flags: 0,
            cts: int(r, -10, 10),
          })),
          trunFlags: pick(r, [0x300, 0xb00, 0x700]),
        }),
      );
      args = {
        moof: b64(damage(r, fr)),
        mdat: b64(damage(r, mdat(int(r, 0, 40), 7))),
      };
      break;
    }
    case 'buildFragment': {
      const n = int(r, 1, 6);
      const cts = chance(r, 0.5);
      args = {
        trackId: int(r, 1, 3),
        sequenceNumber: int(r, 1, 900),
        tfdt: String(
          pick(r, [0, 1024, 7_200_000_000, 48000 * 3600 * 30, -1, 2 ** 64]),
        ),
        samples: Array.from({ length: n }, () => ({
          duration: pick(r, [1024, 960, 1536]),
          size: int(r, 0, 600),
          flags: pick(r, [0, 0x2000000]),
          cts: cts ? int(r, -1024, 2048) : null,
        })),
        data: Array.from({ length: n }, () =>
          b64(Buffer.alloc(int(r, 0, 12), int(r, 0, 255))),
        ),
      };
      break;
    }
    default:
      args = timelineArgs(r, fn);
  }
  return { name: `fuzz ${fn} ${i}`, source: 'fuzz', fn, args };
}

function randomKeyframes(r: Rng): { pts: number; dts: number }[] {
  const n = int(r, 0, 40);
  const step = pick(r, [2, 2.002, 1, 4.17, 10]);
  const origin = pick(r, [0, 1.4, -1.5, 0.08, 600]);
  let t = origin - (chance(r, 0.2) ? r() : 0);
  return Array.from({ length: n }, () => {
    const pts = round3(t);
    t += step * (chance(r, 0.7) ? 1 : r() * 3);
    return {
      pts,
      dts: chance(r, 0.6) ? pts : round3(pts - pick(r, [0.04, 0.083, 0.125])),
    };
  });
}

function timelineArgs(r: Rng, fn: string): any {
  const kfs = randomKeyframes(r);
  const origin =
    kfs.length && chance(r, 0.7) ? kfs[0].pts : pick(r, [0, 1.4, -1.5]);
  const end = (kfs.at(-1)?.pts ?? 30) + pick(r, [0, 0.01, 1.5, -3, 0.03]);
  const segDur = pick(r, [3, 6, 2, 3.003, 10, 0, -1]);
  const frame = chance(r, 0.6) ? 1 / pick(r, FPS) : undefined;
  const grid = computeSegmentGrid(
    kfs,
    origin,
    end,
    segDur > 0 ? segDur : 3,
    frame,
  );
  const audioGrid = chance(r, 0.5)
    ? pick(r, [
        { frame: 1024 / 48000, padding: 1024 / 48000 },
        { frame: 960 / 48000, padding: 312 / 48000 },
        { frame: 1536 / 48000, padding: 256 / 48000 },
        { frame: 1024 / 48000, padding: 2048 / 48000 },
      ])
    : null;
  const run = () => ({
    audioStartSeconds: r() * 30,
    seekSeconds: chance(r, 0.5) ? r() * 30 : null,
    startNumber: int(r, 0, 9),
  });
  const plan = () => {
    const g = chance(r, 0.7) ? grid : null;
    return enc({
      startSegment: int(r, 0, 5),
      startNumber: int(r, 0, 9),
      seekSeconds: r() * 10,
      firstGop: g?.firstKeyframe ?? null,
      gopPts: g?.keyframes.map((k) => k.pts) ?? null,
      gopDts: g?.keyframes.map((k) => k.dts) ?? null,
      start: g ? g.boundaries[0] : origin,
      firstDecode: g?.keyframes[0]?.dts ?? null,
      boundaries: g?.boundaries ?? null,
      segmentDuration: pick(r, [3, 6]),
      audioRenditions: int(r, 0, 3),
    });
  };
  const timeline = () =>
    enc({
      origin: pick(r, [0, 1.4, -23.7, 0.08]),
      formatStart: pick(r, [0, 1.2, -24, 3.18]),
      end: chance(r, 0.5) ? 100 : undefined,
    });
  switch (fn) {
    case 'computeSegmentGrid':
      return enc({ keyframes: kfs, origin, end, segDur, frameSeconds: frame });
    case 'gridSegmentIndex':
      return {
        boundaries: grid?.boundaries ?? [],
        seconds: pick(r, [0, -1, r() * 40, 7, 13]),
        origin: pick(r, [0, 1.4]),
      };
    case 'sourceTimeline':
      return {
        si: chance(r, 0.1)
          ? null
          : wireTimelineInfo(
              enc({
                video: chance(r, 0.8)
                  ? [
                      {
                        firstFrameSeconds: chance(r, 0.6)
                          ? pick(r, [0, 1.4, -1.5, 0.083])
                          : undefined,
                        startTimeSeconds: chance(r, 0.7)
                          ? pick(r, [0, 1.4, 1.36, -1.5])
                          : undefined,
                        endSeconds: chance(r, 0.4) ? 99.5 : undefined,
                      },
                    ]
                  : [],
                formatStartSeconds: chance(r, 0.6)
                  ? pick(r, [0, 1.2, 0.04])
                  : undefined,
                durationSeconds: chance(r, 0.7)
                  ? pick(r, [100, 5400.04])
                  : undefined,
                timestampBreakSeconds: chance(r, 0.2)
                  ? pick(r, [55.5, null])
                  : undefined,
              }),
            ),
      };
    case 'remuxRunStart':
      return {
        grid: chance(r, 0.7) ? grid : null,
        startSegment: int(r, 0, (grid?.durations.length ?? 3) + 1),
        segmentDuration: pick(r, [3, 6, 3.003]),
        origin,
        audioGrid,
      };
    case 'remuxAssemblyPlan':
      return enc({
        grid: chance(r, 0.7) ? grid : null,
        startSegment: int(r, 0, 5),
        run: run(),
        origin,
        segmentDuration: chance(r, 0.5) ? 6 : undefined,
        audioRenditions: chance(r, 0.5) ? int(r, 0, 3) : undefined,
      });
    case 'planBoundarySeconds':
      return { plan: plan(), i: int(r, 0, 12) };
    case 'gopsOf':
      return { plan: plan(), segment: int(r, 0, 12) };
    case 'inputSeekSeconds':
      return { contentSeconds: r() * 100, timeline: timeline() };
    case 'cueOffsetSeconds':
      return { timeline: timeline() };
    default:
      return {
        start: pick(r, [0, 1.4, -1.5, 600.08]),
        firstDecode: pick(r, [0, 1.317, -1.583, 600]),
      };
  }
}

// ── synthetic matrix ────────────────────────────────────────────────────────

const AUDIO_SETS: Record<string, any> = {
  muxed: {},
  'muxed-named': {
    muxedAudio: { language: 'fre', title: 'VF' },
    audioPlans: [{ mode: 'copy', codec: 'ac3', channels: 6 }],
  },
  'no-audio': { audioStreams: [] },
  multi: {
    audioStreams: [
      { language: 'eng', channels: 8 },
      { language: 'eng', title: 'Commentary', channels: 2 },
      { language: 'fre', languageTag: 'fr-CA', channels: 6 },
      {},
    ],
    audioPlans: [
      {
        mode: 'copy',
        codec: 'eac3',
        channels: 8,
        profile: 'Dolby Digital Plus + Dolby Atmos',
      },
      { mode: 'transcode', codec: 'eac3', channels: 2 },
      { mode: 'copy', codec: 'eac3', channels: 6, bitrateBps: 640000 },
    ],
    defaultAudioIndex: 2,
  },
  'multi-dedupe': {
    audioStreams: [
      { language: 'eng' },
      { language: 'eng' },
      { language: 'fre' },
      { language: 'und' },
    ],
    defaultAudioIndex: 1,
    dedupesAudioByLanguage: true,
  },
  'he-aac': {
    audioStreams: [{ language: 'eng' }, { language: 'jpn' }],
    audioPlans: [
      { mode: 'copy', codec: 'aac', profile: 'HE-AAC', channels: 2 },
      { mode: 'copy', codec: 'aac', profile: 'HE-AACv2' },
    ],
  },
  opus: {
    audioPlans: [
      { mode: 'copy', codec: 'opus', channels: 6, bitrateBps: 256000 },
    ],
  },
  truehd: { audioPlans: [{ mode: 'copy', codec: 'truehd', channels: 8 }] },
};

export function syntheticHls(): PVector[] {
  const out: PVector[] = [];
  const add = (name: string, fn: string, args: any) =>
    out.push({
      name: `synthetic ${name}`,
      source: 'synthetic',
      fn,
      args: enc(args) as any,
    });
  const base = (w: number, h: number) => ({
    mediaFileId: 7,
    sourceWidth: w,
    sourceHeight: h,
    tokenParam: '?token=t&sid=s',
    sourceFrameRate: 24,
  });
  for (const [w, h] of SIZES) {
    for (const v of SDR)
      add(`master sdr ${v.codec} ${w}x${h}`, 'masterPlaylist', {
        ...base(w, h),
        sdrVariant: v,
        sourceVideoBitrateBps: 6_000_000,
        sourceVideoCodec: 'h264',
      });
    for (const v of HDR)
      add(`master hdr ${v.codec} ${v.hdr} ${w}x${h}`, 'masterPlaylist', {
        ...base(w, h),
        hdrPassThrough: { hdrFormat: v.hdr, hdrVariant: v },
        canEmitHdrLadder: true,
        sourceFrameRate: 23.976,
      });
    add(`master remux ${w}x${h}`, 'masterPlaylist', {
      ...base(w, h),
      includeRemux: true,
      remuxCodecs: 'avc1.640029',
      sourceVideoBitrateBps: 9_876_543,
      remuxWidth: w,
      remuxHeight: h + 8,
    });
  }
  for (const [k, a] of Object.entries(AUDIO_SETS)) {
    add(`master audio ${k}`, 'masterPlaylist', { ...base(1920, 1080), ...a });
    add(`master audio ${k} remux`, 'masterPlaylist', {
      ...base(1920, 1080),
      ...a,
      includeRemux: true,
      formatBitRate: 12_345_678,
    });
  }
  for (const q of PINS) {
    add(`master pin ${q}`, 'masterPlaylist', {
      ...base(1920, 1080),
      onlyQuality: q,
    });
    add(`master pin ${q} hdr`, 'masterPlaylist', {
      ...base(3840, 2160),
      onlyQuality: q,
      hdrPassThrough: { hdrFormat: 'HDR10', hdrVariant: HDR[0] },
      canEmitHdrLadder: true,
    });
  }
  add('master no-abr sdr', 'masterPlaylist', {
    ...base(1918, 872),
    supportsAbr: false,
  });
  add('master no-abr hdr', 'masterPlaylist', {
    ...base(3840, 2160),
    supportsAbr: false,
    hdrPassThrough: { hdrFormat: 'HLG', hdrVariant: HDR[1] },
    canEmitHdrLadder: true,
  });
  add('master hdr remux dv', 'masterPlaylist', {
    ...base(3840, 2160),
    includeRemux: true,
    hdrPassThrough: { hdrFormat: 'HDR10', hdrVariant: HDR[0] },
    remuxCodecs: 'hvc1.2.4.L153.B0',
    remuxSupplementalCodecs: 'dvh1.08.06/db4h',
    sourceHdrFormat: 'HDR10',
  });
  add('master subtitles', 'masterPlaylist', {
    ...base(1920, 1080),
    subtitleRenditions: [
      { kind: 'embedded', key: 3, language: 'eng', name: 'English' },
      {
        kind: 'external',
        key: 12,
        language: 'eng',
        name: 'English',
        forced: true,
      },
      {
        kind: 'external',
        key: 13,
        language: 'por',
        languageTag: 'pt-BR',
        name: '',
      },
    ],
  });
  for (const fps of FPS)
    add(`master fps ${fps}`, 'masterPlaylist', {
      ...base(1920, 1080),
      sourceFrameRate: fps,
      iFrameTrickPlaySegmentSeconds: 3.003,
    });
  for (const s of [0.5, 2.002, 6])
    add(`master iframe ${s}`, 'masterPlaylist', {
      ...base(4096, 1716),
      iFrameTrickPlaySegmentSeconds: s,
    });
  const segs = { prefix: '/api/stream/7/720p/seg-', suffix: '.m4s?token=t' };
  for (const d of DURATIONS.filter((x) => x < 200)) {
    for (const [sd, fps] of [
      [3, 24],
      [3.003, 23.976],
      [6, 25],
      [2, 59.94],
    ] as const) {
      add(`vod ${d} ${sd}`, 'vodPlaylist', {
        duration: d,
        seg: segs,
        init: '/api/stream/7/720p/init.mp4?token=t',
        segDuration: sd,
        frameSeconds: 1 / fps,
      });
      add(`iframe ${d} ${sd}`, 'iframePlaylist', {
        duration: d,
        seg: { prefix: 'iframe/seg-', suffix: '.ts' },
        segDuration: sd,
        frameSeconds: 1 / fps,
      });
    }
  }
  const g = computeSegmentGrid(
    [0, 7.966, 15.974, 19.937].map((pts) => ({ pts, dts: pts })),
    0,
    25,
    6,
  )!;
  add('variable spec grid', 'variableVodPlaylist', {
    durations: g.durations,
    seg: segs,
    init: 'init.mp4',
  });
  add('variable empty', 'variableVodPlaylist', { durations: [], seg: segs });
  for (const q of ['remux', '1080p', '2160p-hdr']) {
    for (const live of [
      null,
      { remuxGrid: g, kind: 'remux' },
      { remuxGrid: null, sourceFps: 23.81 },
      { useTs: true, useExtXMedia: true, sourceFps: 25 },
      { useExtXMedia: true },
    ]) {
      add(`route ${q} ${JSON.stringify(live)}`, 'variantRoute', {
        mediaFileId: 42,
        quality: q,
        live,
        frameRate: '23.976',
        segmentDuration: 6,
        resolvedDuration: 25,
        durationHint: '25',
        token: 'abc',
      });
    }
  }
  for (const live of [
    null,
    { kind: 'remux', remuxGrid: g },
    { kind: 'remux' },
    { kind: 'transcode', useTs: true, sourceFps: 24000 / 1001 },
  ]) {
    add(`audio route ${JSON.stringify(live)}`, 'audioRoute', {
      mediaFileId: 42,
      audioIndex: 1,
      live,
      frameRate: '24000/1001',
      segmentDuration: 3,
      resolvedDuration: 125.5,
      sid: 's1',
    });
    add(`iframe route ${JSON.stringify(live)}`, 'iframeRoute', {
      mediaFileId: 42,
      live,
      frameRate: '25',
      segmentDuration: 3,
      resolvedDuration: 125.5,
    });
  }
  for (const d of [undefined, 0, 0.4, 7322.5]) {
    add(`subtitle embedded ${d}`, 'subtitleRoute', {
      mediaFileId: 9,
      kind: 'embedded',
      key: 2,
      durationSeconds: d,
      token: 't',
    });
    add(`subtitle external ${d}`, 'subtitleRoute', {
      mediaFileId: 9,
      kind: 'external',
      key: 31,
      durationSeconds: d,
    });
  }
  return out;
}

export function syntheticMp4(): PVector[] {
  const out: PVector[] = [];
  const add = (name: string, fn: string, args: any) =>
    out.push({
      name: `synthetic ${name}`,
      source: 'synthetic',
      fn,
      args: enc(args) as any,
    });
  const av = init(
    [
      { id: 1, ts: 12800, edits: [[0, 1024]] },
      {
        id: 2,
        ts: 48000,
        handler: 'soun',
        edits: [
          [100, -1],
          [0, 2048],
        ],
      },
    ],
    {
      movieTs: 1000,
      trex: [
        [1, 512],
        [2, 1024],
      ],
    },
  );
  const v1 = init(
    [{ id: 1, ts: 90000, v1: true, edits: [[0, 0x80000000]], editsV1: true }],
    { movieTs: 0 },
  );
  const emptyEdit = init([{ id: 1, ts: 1000, edits: [[5, -1]] }], {});
  for (const [n, i] of Object.entries({ av, v1, emptyEdit })) {
    add(`init ${n} tracks`, 'parseInitTracks', { init: i });
    add(`init ${n} edits`, 'readInitEdits', { init: i });
    add(`init ${n} trex`, 'parseTrexDefaults', { init: i });
    add(`init ${n} with edits`, 'withInitEdits', {
      init: i,
      seconds: [
        [1, 0.08],
        [2, 0.0213],
      ],
    });
  }
  const seg = (tv: bigint, ta: bigint, v1t = false) =>
    Buffer.concat([
      styp(),
      sidx(),
      moof(
        1,
        traf({
          id: 1,
          tfdt: tv,
          tfdtV1: v1t,
          samples: [
            { duration: 512, size: 10 },
            { duration: 512, size: 12 },
          ],
        }),
        traf({
          id: 2,
          tfdt: ta,
          tfdtV1: v1t,
          defaults: { duration: 1024 },
          samples: [{ size: 5 }],
          trunFlags: 0x200,
        }),
      ),
      mdat(27),
    ]);
  const tracks = [
    [1, { timescale: 12800, isVideo: true }],
    [2, { timescale: 48000, isVideo: false }],
  ];
  for (const [idx, sd, sp] of [
    [0, 3, 0],
    [20, 3, 0],
    [20, 3.003, 2.8],
    [7, 6, -23.717689],
    [1, 3, 0.08],
  ] as const) {
    add(`rewrite ${idx} ${sd} ${sp}`, 'rewriteSegmentTfdt', {
      seg: seg(0n, 1024n),
      tracks,
      segIndex: idx,
      segDuration: sd,
      startPts: sp,
    });
    add(`rewrite v1 ${idx} ${sd} ${sp}`, 'rewriteSegmentTfdt', {
      seg: seg(-1024n, -2048n, true),
      tracks,
      segIndex: idx,
      segDuration: sd,
      startPts: sp,
    });
    add(`rewrite audio-only ${idx} ${sd} ${sp}`, 'rewriteSegmentTfdt', {
      seg: seg(0n, 1000n),
      tracks: [[2, { timescale: 48000, isVideo: false }]],
      segIndex: idx,
      segDuration: sd,
      startPts: sp,
    });
  }
  add('rewrite v0 overflow', 'rewriteSegmentTfdt', {
    seg: seg(0n, 0n),
    tracks,
    segIndex: 100000,
    segDuration: 6,
    startPts: 0,
  });
  add('retime', 'retimeFragments', {
    seg: seg(5000n, 9000n, true),
    deltas: [
      [1, '1280'],
      [2, '-9000'],
    ],
  });
  add('retime negative', 'retimeFragments', {
    seg: seg(5000n, 9000n),
    deltas: [
      [1, '-5001'],
      [2, '0'],
    ],
  });
  add('retime absent track', 'retimeFragments', {
    seg: seg(5000n, 9000n),
    deltas: [[1, '1']],
  });
  add('first tfdt', 'firstTfdt', { seg: seg(-77n, 5n, true), trackId: 1 });
  add('extent', 'videoDecodeExtent', {
    moofs: seg(100n, 0n),
    trackId: 1,
    trexDefault: 0,
  });
  add('extent defaults', 'videoDecodeExtent', {
    moofs: seg(100n, 0n),
    trackId: 2,
    trexDefault: 0,
  });
  const raw = Buffer.concat([
    ftyp(['iso5', 'iso6', 'mp41']),
    styp(),
    sidx(),
    moof(1, traf({ id: 1, tfdt: 0n })),
    mdat(3),
  ]);
  add('cmaf ffmpeg output', 'cmafRewrite', { buf: raw });
  add('cmaf already', 'cmafRewrite', {
    buf: Buffer.concat([ftyp(['iso5', 'hlsf']), mdat(1)]),
  });
  add('cmaf truncated', 'cmafRewrite', {
    buf: raw.subarray(0, raw.length - 2),
  });
  add('cmaf size 0', 'cmafRewrite', {
    buf: Buffer.concat([
      styp(),
      Buffer.from([0, 0, 0, 0, 0x6d, 0x64, 0x61, 0x74, 1, 2]),
    ]),
  });
  for (const b of [
    raw,
    Buffer.concat([ftyp(['iso5', 'hlsf']), mdat(1)]),
    moof(1),
    Buffer.alloc(11),
    Buffer.alloc(0),
  ]) {
    add(`cmaf is rewritten ${b.length}`, 'isCmafRewritten', { buf: b });
    add(`cmaf read ${b.length}`, 'readAndRewriteCmaf', { buf: b });
  }
  const kf = (...p: number[]) => p.map((x) => ({ pts: x, dts: x }));
  const grids: [string, any][] = [
    ['regular', [kf(0, 2, 4, 6, 8, 10, 12), 0, 13, 3]],
    ['irregular', [kf(0, 2, 4, 7, 9, 13, 15), 0, 18, 6]],
    ['origin', [kf(1.4, 4.4, 7.4), 1.4, 10.4, 3]],
    ['negative origin', [kf(-1.5, 0.5, 2.5, 4.5), -1.5, 6, 3]],
    [
      'open gop',
      [
        [
          { pts: 0.083, dts: 0 },
          { pts: 2.085, dts: 2.002 },
          { pts: 4.087, dts: 4.004 },
        ],
        0.083,
        6,
        2,
      ],
    ],
    ['past end', [kf(0, 5, 10, 20), 0, 15, 6]],
    ['last frame', [kf(0, 3, 5.98), 0, 6, 3]],
    ['break', [kf(0, 3, 6, 9, 12), 0, 7.5, 3]],
    ['none', [[], 0, 10, 3]],
  ];
  for (const [n, [k, o, e, s]] of grids) {
    add(`grid ${n}`, 'computeSegmentGrid', {
      keyframes: k,
      origin: o,
      end: e,
      segDur: s,
      frameSeconds: 1 / 25,
    });
    const g = computeSegmentGrid(k, o, e, s, 1 / 25);
    for (const at of [0, 1, 5.5, 100])
      add(`grid index ${n} ${at}`, 'gridSegmentIndex', {
        boundaries: g?.boundaries ?? [],
        seconds: at,
        origin: o,
      });
    for (const start of [0, 1, 2, 9]) {
      for (const ag of [null, { frame: 1024 / 48000, padding: 1024 / 48000 }]) {
        add(`run start ${n} ${start} ${ag ? 'aac' : 'copy'}`, 'remuxRunStart', {
          grid: g,
          startSegment: start,
          segmentDuration: s,
          origin: o,
          audioGrid: ag,
        });
      }
      const run = {
        audioStartSeconds: o,
        seekSeconds: start ? o + start : null,
        startNumber: start,
      };
      add(`plan ${n} ${start}`, 'remuxAssemblyPlan', {
        grid: g,
        startSegment: start,
        run,
        origin: o,
        audioRenditions: 2,
      });
    }
  }
  for (const si of [
    null,
    {
      video: [
        { firstFrameSeconds: 1.4, startTimeSeconds: 1.36, endSeconds: 99 },
      ],
      formatStartSeconds: 1.2,
      durationSeconds: 100,
    },
    { video: [{ startTimeSeconds: 2.8 }], durationSeconds: 60 },
    {
      video: [{ firstFrameSeconds: -23.717689 }],
      formatStartSeconds: -24,
      timestampBreakSeconds: 55.5,
    },
    { video: [], durationSeconds: 10, timestampBreakSeconds: null },
  ]) {
    add(`timeline ${JSON.stringify(si)}`, 'sourceTimeline', {
      si: wireTimelineInfo(si),
    });
  }
  add('build fragment', 'buildFragment', {
    trackId: 2,
    sequenceNumber: 5,
    tfdt: '96000',
    samples: [
      { duration: 1024, size: 3, flags: 0, cts: null },
      { duration: 1024, size: 2, flags: 0, cts: null },
    ],
    data: [Buffer.from([1, 2, 3]), Buffer.from([4, 5])],
  });
  add('build fragment negative cts', 'buildFragment', {
    trackId: 2,
    sequenceNumber: 1,
    tfdt: '0',
    samples: [{ duration: 1024, size: 1, flags: 0, cts: -512 }],
    data: [Buffer.from([9])],
  });
  return out;
}
