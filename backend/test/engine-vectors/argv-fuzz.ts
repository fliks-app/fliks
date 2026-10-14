import {
  DESKTOP_HDR_PROFILES,
  DESKTOP_PROFILES,
  ECO_HDR_PROFILES,
  ECO_PROFILES,
} from '../../src/modules/streaming/transcoding/profiles';
import { ALL_DESCRIPTORS } from '../../src/modules/streaming/transcoding/codec/encoders';
import { buildVideoFilters } from '../../src/modules/streaming/transcoding/ffmpeg-filter-graph';
import { DEFAULT_ENV, type ArgvVector } from './argv-vector';
import type { ArgvEnv } from './argv-recorder';
import { genHostCaps } from './fuzz';

type Rng = () => number;
type Obj = Record<string, unknown>;

const int = (r: Rng, lo: number, hi: number) =>
  lo + Math.floor(r() * (hi - lo + 1));
const chance = (r: Rng, p: number) => r() < p;
const pick = <T>(r: Rng, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)];
const maybe = <T>(r: Rng, p: number, v: () => T): T | undefined =>
  chance(r, p) ? v() : undefined;

const HW = ['none', 'vaapi', 'qsv', 'nvenc', 'amf', 'videotoolbox'] as const;
const PROFILES = [
  ...DESKTOP_PROFILES,
  ...ECO_PROFILES,
  ...DESKTOP_HDR_PROFILES,
  ...ECO_HDR_PROFILES,
];
const DIMS: ([number, number] | undefined)[] = [
  [3840, 2160],
  [1920, 1080],
  [1920, 800],
  [1280, 720],
  [720, 576],
  [3840, 1600],
  [1080, 1920],
  [1998, 1080],
  [0, 0],
  undefined,
];
const MASTER_DISPLAYS = [
  'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)',
  'G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(40000000,50)',
  'G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,1)',
  'garbage',
  '',
];
const AUDIO_COPY = [
  'aac',
  'ac3',
  'eac3',
  'opus',
  'flac',
  'dts',
  'truehd',
  'mp3',
];
const AUDIO_ENC = ['aac', 'ac3', 'eac3', 'opus'] as const;
const LANGS = ['eng', 'fre', 'jpn', '', 'und'];

function env(r: Rng): ArgvEnv {
  return {
    renderNode: chance(r, 0.1)
      ? pick(r, ['/dev/dri/renderD129', '/dev/dri/card1'])
      : DEFAULT_ENV.renderNode,
    openclDevice: chance(r, 0.1) ? pick(r, ['0.0', '1.0', ' 0.1 ', '']) : null,
  };
}

function variant(r: Rng): Obj {
  const codec = pick(r, ['h264', 'hevc', 'hevc', 'av1'] as const);
  const hdr =
    codec === 'h264' ? null : pick(r, [null, null, 'HDR10', 'HLG'] as const);
  let bitDepth = hdr ? 10 : 8;
  if (chance(r, 0.03)) bitDepth = 18 - bitDepth;
  return {
    codec,
    bitDepth,
    hdr: chance(r, 0.01) && codec === 'h264' ? 'HDR10' : hdr,
  };
}

function crop(r: Rng, dims: [number, number] | undefined): Obj | undefined {
  const [w, h] = dims && dims[0] > 0 ? dims : [1920, 1080];
  if (!chance(r, 0.3)) return undefined;
  const ch = h - 2 * int(r, 0, h / 8);
  const cw = chance(r, 0.2) ? w - 2 * int(r, 1, w / 10) : w;
  return { width: cw, height: ch, x: (w - cw) / 2, y: (h - ch) / 2 };
}

function burnIn(r: Rng): Obj | undefined {
  const x = r();
  if (x < 0.6) return undefined;
  if (x < 0.8)
    return {
      type: 'text',
      filter: pick(r, [
        "subtitles='/subs/a.srt'",
        "subtitles='/subs/b.ass':si=0",
      ]),
    };
  if (x < 0.95) return { type: 'image', streamIndex: int(r, 2, 12) };
  return { type: 'image' };
}

function hdrMetadata(r: Rng): Obj | undefined {
  return maybe(r, 0.5, () => ({
    masteringDisplay: pick(r, MASTER_DISPLAYS),
    maxCll: pick(r, [0, 1000, 4000, 650]),
    maxFall: pick(r, [0, 400, 120]),
  }));
}

function audioStreams(r: Rng): Obj[] | undefined {
  if (chance(r, 0.25)) return undefined;
  return Array.from({ length: int(r, 0, 4) }, (_, i) => ({
    ...(chance(r, 0.8) ? { language: pick(r, LANGS) } : {}),
    ...(chance(r, 0.7) ? { streamIndex: i + int(r, 1, 3) } : {}),
    ...(chance(r, 0.6) ? { channels: pick(r, [1, 2, 6, 8]) } : {}),
  }));
}

function audioPlan(r: Rng): Obj {
  if (chance(r, 0.45))
    return {
      mode: 'copy',
      codec: pick(r, AUDIO_COPY),
      ...(chance(r, 0.7) ? { channels: int(r, 1, 8) } : {}),
      ...(chance(r, 0.5)
        ? { bitrateBps: pick(r, [128000, 384000, 640000, 1509000]) }
        : {}),
      ...(chance(r, 0.2)
        ? { profile: pick(r, ['LC', 'HE-AAC', 'DTS-HD MA']) }
        : {}),
    };
  return {
    mode: 'transcode',
    codec: pick(r, AUDIO_ENC),
    channels: int(r, 1, 8),
  };
}

function trackPlans(r: Rng, streams: Obj[] | undefined): Obj[] | undefined {
  if (!streams || !chance(r, 0.5)) return undefined;
  const n = streams.length + (chance(r, 0.05) ? 1 : 0);
  return Array.from({ length: n }, () => audioPlan(r));
}

function vod(r: Rng): Obj {
  const dims = pick(r, DIMS);
  const start = chance(r, 0.4) ? 0 : int(r, 1, 400);
  const pts = pick(r, [undefined, 0, 0, 0.042, 1.4, -0.083, 10.5]);
  const seg = pick(r, [undefined, 2, 3, 3, 4, 6, 2.5]);
  const streams = audioStreams(r);
  return {
    inputPath: '/media/in file.mkv',
    outputDir: pick(r, ['/cache/out', 'C:\\cache\\out', '/cache/out/']),
    profile: pick(r, PROFILES),
    hwAccel: pick(r, HW),
    startSegment: start,
    tonemap: chance(r, 0.35),
    burnIn: burnIn(r),
    audioStreamIndex: maybe(r, 0.3, () => int(r, 0, 3)),
    crop: crop(r, dims),
    videoOnly: chance(r, 0.5),
    audioStreams: streams,
    videoVariant: maybe(r, 0.99, () => variant(r)),
    sourceVideoCodec: pick(r, [
      'h264',
      'hevc',
      'av1',
      'avc1',
      'hev1',
      'hvc1',
      'av01',
      'h265',
      'HEVC',
      'vp9',
      'mpeg2video',
      undefined,
    ]),
    sourceBitDepth: pick(r, [8, 10, undefined]),
    sourceWidth: dims?.[0],
    sourceHeight: dims?.[1],
    sourceVideoBitrateBps: maybe(r, 0.6, () =>
      pick(r, [800_000, 3_500_000, 12_000_000, 45_000_000]),
    ),
    sourceHdrMetadata: hdrMetadata(r),
    sourceDvProfile: pick(r, [undefined, undefined, 5, 7, 8, 10]),
    sourceDvBlSignalCompatId: pick(r, [undefined, 0, 1, 2, 4, 6]),
    audioPlan: maybe(r, 0.85, () => audioPlan(r)),
    audioTrackPlans: trackPlans(r, streams),
    sourceStartPts: pts,
    sourceFormatStart:
      pts == null ? undefined : pick(r, [undefined, pts, pts - 0.5, 0]),
    seekKeyframeDts: maybe(r, 0.15, () => Math.max(0, start * 3 - r() * 2)),
    sourceClockBreakSeconds: maybe(r, 0.1, () =>
      pick(r, [600, 1234.567, 26.5]),
    ),
    sourceEndSeconds: maybe(r, 0.5, () =>
      pick(r, [5400, 1234.5678, 12.0, 0.5]),
    ),
    videoStreamIndex: maybe(r, 0.5, () => int(r, 0, 3)),
    encoderPreset: pick(r, [
      undefined,
      'faster',
      'veryfast',
      'fast',
      'medium',
      'slow',
    ]),
    tonemapAlgo: pick(r, [undefined, 'auto', 'opencl', 'vaapi', 'qsv']),
    tonemapCurve: pick(r, [undefined, 'hable', 'mobius', 'reinhard']),
    sourceFps: pick(r, [
      24,
      23.976,
      25,
      29.97,
      30,
      50,
      59.94,
      60,
      undefined,
      0,
    ]),
    sourceColorSpace: pick(r, [
      undefined,
      'bt709',
      'bt2020nc',
      'smpte170m',
      'unknown',
      'reserved',
      'bt470bg',
    ]),
    sourceColorPrimaries: pick(r, [
      undefined,
      'bt709',
      'bt2020',
      'smpte170m',
      'unknown',
    ]),
    sourceColorTransfer: pick(r, [
      undefined,
      'bt709',
      'smpte2084',
      'arib-std-b67',
      'unknown',
      'smpte170m',
    ]),
    sourceColorRange: pick(r, [
      undefined,
      'tv',
      'pc',
      'full',
      'jpeg',
      'PC',
      'unknown',
    ]),
    segmentDuration: seg,
    trustedStreamInfo: pick(r, [true, false, undefined]),
    early: chance(r, 0.15),
    useTs: chance(r, 0.2),
  };
}

function remux(r: Rng): Obj {
  const streams = audioStreams(r);
  const seek = chance(r, 0.5) ? null : pick(r, [21.021, 0.5, 300, -0.01]);
  return {
    inputPath: '/media/in.mkv',
    outputDir: '/cache/remux/run',
    run: {
      audioStartSeconds: pick(r, [0, 21.0, 300.032, -0.083]),
      seekSeconds: seek,
      startNumber: seek == null ? 0 : int(r, 1, 200),
    },
    trustedStreamInfo: pick(r, [true, false, undefined]),
    audioStreamIndex: maybe(r, 0.3, () => int(r, 0, 3)),
    sourceVideoCodec: pick(r, ['hevc', 'av1', 'h264', 'HEVC', undefined]),
    audioStreams: streams,
    grid: chance(r, 0.5)
      ? null
      : {
          durations: [3, 3],
          boundaries: [0, 3, 6],
          keyframes: [],
          firstKeyframe: [0, 1, 2],
        },
    segmentDuration: pick(r, [undefined, 2, 3, 4, 6, 2.5]),
    videoStreamIndex: maybe(r, 0.5, () => int(r, 0, 3)),
    sourceEndSeconds: maybe(r, 0.5, () => pick(r, [5400, 12.5])),
    sourceClockBreakSeconds: maybe(r, 0.1, () => pick(r, [600, 26.5])),
    audioPlan: maybe(r, 0.85, () => audioPlan(r)),
    audioTrackPlans: trackPlans(r, streams),
    videoOnly: chance(r, 0.5),
    dolbyVision: chance(r, 0.4),
    sourceDvProfile: pick(r, [undefined, 5, 7, 8, 10]),
    sourceDvBlSignalCompatId: pick(r, [undefined, 0, 1, 4]),
    hdr10Plus: chance(r, 0.3),
  };
}

function live(r: Rng): Obj {
  return {
    inputUrl: 'http://provider.example/live/1.ts',
    outputDir: '/cache/live/1',
    segmentSeconds: pick(r, [1, 2, 3, 4, 6, 2.5, 0.7]),
    windowMinutes: pick(r, [0, 1, 5, 30, 0.5]),
    mode: pick(r, ['remux', 'transcode']),
    useTs: chance(r, 0.4),
    userAgent: pick(r, [undefined, '', 'Kodi/20']),
    referer: pick(r, [undefined, '', 'http://ref.example/']),
    hwAccel: pick(r, HW),
    videoBitrateBps: maybe(r, 0.4, () =>
      pick(r, [1_500_000, 4_000_000, 2_500_001]),
    ),
    audioCodec: pick(r, [undefined, 'aac', 'aac', 'ac3', 'mp2', 'AAC']),
    append: pick(r, [undefined, true, false]),
    probeSeconds: pick(r, [undefined, 1, 3, 5, 10, 2.5]),
  };
}

function encoder(r: Rng): Obj {
  const d = pick(r, ALL_DESCRIPTORS);
  const [width, height] = pick(r, [
    [1920, 1080],
    [1280, 720],
    [3840, 2160],
    [854, 480],
  ]);
  const tonemap = chance(r, 0.35);
  const useVaapiTonemap = tonemap && chance(r, 0.3);
  const c = crop(r, [3840, 2160]);
  const b = burnIn(r);
  const dvNoBase = chance(r, 0.2);
  const dvApplyRpu = dvNoBase || chance(r, 0.15);
  const curve = pick(r, [undefined, 'hable', 'mobius', 'reinhard'] as const);
  const gop = pick(r, [48, 72, 60, 144]);
  return {
    id: d.id,
    input: {
      variant: d.variant,
      target: {
        width,
        height,
        videoBitrateBps: pick(r, [8_000_000, 2_800_000, 20_000_000]),
        gopSize: gop,
        frameRate: pick(r, [24, 23.976, 60]),
      },
      preset: pick(r, [
        'veryfast',
        'faster',
        'fast',
        'medium',
        'slow',
        'other',
      ]),
      nvencPreset: pick(r, ['p4', 'p1']),
      seekSeconds: pick(r, [0, 21]),
      early: chance(r, 0.2),
      forceKeyframesExpr: `expr:gte(n,n_forced*${gop})`,
      qsv: {
        extra: chance(r, 0.8)
          ? [
              '-forced_idr',
              '1',
              '-adaptive_i',
              '0',
              '-bf',
              '0',
              '-b_strategy',
              '0',
            ]
          : [],
        rcInitOccupancy: pick(r, [4_000_000, 8_000_000]),
        bufsize: pick(r, [8_000_000, 2_800_000]),
      },
      libx264BufsizeMb: pick(r, ['16M', '8M', '1M']),
      filters: buildVideoFilters({
        crop: c as never,
        burnIn: b as never,
        tonemap,
        useVaapiTonemap,
        useVulkanTonemap: !useVaapiTonemap && chance(r, 0.15),
        sourceBitDepth: pick(r, [8, 10]),
        dvNoBase,
        dvApplyRpu,
        tonemapCurve: curve,
        scaleWidth: width,
        scaleHeight: maybe(r, 0.5, () => height),
        openclTonemap: chance(r, 0.3),
        cudaTonemap: chance(r, 0.3),
        hdr10Target: dvNoBase && chance(r, 0.4),
      }),
      tonemap,
      tonemapPath: pick(r, ['vaapi', 'opencl', 'qsv', 'vulkan']),
      ...(curve ? { tonemapCurve: curve } : {}),
      dvApplyRpu,
      hasBurnIn: !!b?.filter,
      hasCrop: !!c,
      inputSurface: pick(r, ['cpu', 'vaapi', 'cuda', 'd3d11', 'videotoolbox']),
      ...(chance(r, 0.5) ? { qsvNative: chance(r, 0.5) } : {}),
      ...(chance(r, 0.4) ? { hdrMetadata: hdrMetadata(r) } : {}),
    },
  };
}

const dropUndefined = (x: unknown): unknown => JSON.parse(JSON.stringify(x));

export function genArgvVector(r: Rng, name: string): ArgvVector {
  const x = r();
  const kind =
    x < 0.7 ? 'vod' : x < 0.82 ? 'remux' : x < 0.92 ? 'live' : 'encoder';
  const hostCaps = genHostCaps(r);
  const e = env(r);
  const input =
    kind === 'vod'
      ? vod(r)
      : kind === 'remux'
        ? remux(r)
        : kind === 'live'
          ? live(r)
          : encoder(r);
  if (kind === 'vod' && chance(r, 0.9)) input.hwAccel = hostCaps.hwAccel;
  return {
    name,
    source: 'fuzz',
    kind,
    hostCaps,
    env: e,
    input: dropUndefined(input),
  };
}
