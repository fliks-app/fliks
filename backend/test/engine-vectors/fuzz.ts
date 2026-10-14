import type { DeviceProfileDto } from '../../src/modules/streaming/dto/device-profile.dto';
import { DEVICES } from './cases';
import type { HostCaps, ProbeName } from './host-caps';
import {
  wireDevice,
  wireInfo,
  wireScan,
  type Vector,
  type VectorConfig,
} from './vector';

/** Tiny seeded PRNG (mulberry32): one seed always yields the same vectors. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
type Obj = Record<string, unknown>;

const int = (r: Rng, lo: number, hi: number) =>
  lo + Math.floor(r() * (hi - lo + 1));
const chance = (r: Rng, p: number) => r() < p;
const pick = <T>(r: Rng, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)];
const subset = <T>(r: Rng, xs: readonly T[], p = 0.5): T[] =>
  xs.filter(() => r() < p);
const tri = (r: Rng, pTrue = 0.3, pFalse = 0.3): boolean | undefined => {
  const x = r();
  return x < pTrue ? true : x < pTrue + pFalse ? false : undefined;
};
/** Omits the key when `v` is undefined (JSON drops it). */
const maybe = <T>(r: Rng, p: number, v: () => T): T | undefined =>
  chance(r, p) ? v() : undefined;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

const VIDEO_CODECS = [
  'h264',
  'hevc',
  'av1',
  'vp9',
  'mpeg2video',
  'mpeg4',
  'vc1',
];
const AUDIO_CODECS = [
  'aac',
  'ac3',
  'eac3',
  'dts',
  'truehd',
  'flac',
  'opus',
  'mp3',
  'vorbis',
  'pcm_s16le',
  'alac',
  'mp2',
];
const CONTAINERS: Record<string, { fmt?: string; mime: string }> = {
  mkv: { fmt: 'matroska,webm', mime: 'video/x-matroska' },
  mp4: { fmt: 'mov,mp4,m4a,3gp,3g2,mj2', mime: 'video/mp4' },
  m4v: { fmt: 'mov,mp4,m4a,3gp,3g2,mj2', mime: 'video/x-m4v' },
  mov: { fmt: 'mov,mp4,m4a,3gp,3g2,mj2', mime: 'video/quicktime' },
  webm: { fmt: 'matroska,webm', mime: 'video/webm' },
  ts: { fmt: 'mpegts', mime: 'video/mp2t' },
  m2ts: { fmt: 'mpegts', mime: 'video/mp2t' },
  mts: { fmt: 'mpegts', mime: 'video/mp2t' },
  avi: { fmt: 'avi', mime: 'video/x-msvideo' },
  wmv: { fmt: 'asf', mime: 'video/x-ms-wmv' },
  mpg: { fmt: 'mpeg', mime: 'video/mpeg' },
  flv: { fmt: 'flv', mime: 'video/x-flv' },
  tp: { fmt: 'mpegts', mime: 'video/mp2t' },
};
const EXTS = Object.keys(CONTAINERS);
const LANGS = ['eng', 'fra', 'jpn', 'und', 'spa', 'ger', 'kor', 'ita'];
const RUNGS = [
  '2160p',
  '1080p',
  '720p',
  '480p',
  '360p',
  '240p',
  '144p',
  'eco-2160p',
  'eco-1080p',
  'eco-720p',
  '2160p-hdr',
  '1080p-hdr',
  '720p-hdr',
  '480p-hdr',
  'eco-2160p-hdr',
  'eco-1080p-hdr',
];
const ODD_QUALITIES = [
  '540p',
  '1440p',
  '4320p',
  '0p',
  'eco-540p',
  '720P',
  'foo',
  '4k',
  '1080',
  '',
  '600p-hdr',
  'Auto',
  'ORIGINAL',
  '99999p',
];
const PROBES: ProbeName[] = [
  'tonemapOpencl',
  'tonemapOpenclCrop',
  'tonemapOpenclHdr10',
  'qsvOpencl',
  'qsvOpenclHdr10',
  'vppQsv',
  'vulkan',
  'cuda',
  'cudaHdr10',
  'opencl',
  'openclHdr10',
  'amfOpencl',
];
const ENCODERS = [
  'libx264',
  'libx265',
  'libx265_main10',
  'libx265_hlg',
  'libsvtav1',
  'libsvtav1_hdr10',
  'libsvtav1_hlg',
  ...['h264', 'hevc', 'av1'].flatMap((c) =>
    ['qsv', 'vaapi', 'nvenc', 'amf', 'videotoolbox'].flatMap((b) => [
      `${c}_${b}`,
      `${c}_${b}_main10`,
      `${c}_${b}_hdr10`,
      `${c}_${b}_hlg`,
    ]),
  ),
];
const DECODERS = ['h264', 'hevc', 'av1', 'vp9', 'mpeg2video'].flatMap((c) =>
  [
    'qsv',
    'vaapi',
    'cuda',
    'videotoolbox',
    'd3d11va',
    'd3d11va_native',
    'qsv_d3d11',
  ].map((b) => `${c}_${b}_decode`),
);

// --- media ---

// Both sides of every bucket / cap edge the decision compares against.
const EDGE_W = [256, 426, 640, 854, 1280, 1920, 3840, 4096];
const EDGE_H = [
  144, 192, 240, 320, 360, 432, 480, 576, 720, 962, 1080, 1440, 2160,
];
const RES: [number, number][] = [
  [1920, 1080],
  [3840, 2160],
  [1280, 720],
  [854, 480],
  [640, 360],
  [426, 240],
  [256, 144],
  [720, 480],
  [720, 576],
  [1920, 800],
  [1920, 816],
  [3840, 1600],
  [1440, 1080],
  [4096, 2160],
  [7680, 4320],
  [1280, 544],
  [1080, 1920],
  [1920, 1088],
  [1920, 960],
  [2560, 1440],
  [352, 288],
  [320, 240],
  [960, 540],
  [3840, 2076],
  [1, 1],
  [2, 2],
  [16, 16],
  [8192, 4320],
];

function genVideo(r: Rng): Obj {
  const scenario = pick(r, [
    'sdr',
    'sdr',
    'sdr',
    'sdr',
    'hdr10',
    'hdr10',
    'hlg',
    'hdr10plus',
    'p5',
    'p7',
    'p81',
    'p84',
    'p82',
    'p10',
    'pweird',
  ]);
  const codec =
    scenario === 'sdr' || scenario === 'pweird'
      ? pick(r, [...VIDEO_CODECS, 'h264', 'h264', 'hevc', 'hevc'])
      : pick(r, ['hevc', 'hevc', 'hevc', 'av1', 'h264', 'h264', 'vp9']);
  const [w, h] = chance(r, 0.2)
    ? [pick(r, EDGE_W) + int(r, -1, 1), pick(r, EDGE_H) + int(r, -1, 1)]
    : chance(r, 0.85)
      ? pick(r, RES)
      : [int(r, 16, 8192), int(r, 16, 4400)];
  const hdr = scenario !== 'sdr';
  const profile = {
    h264: [
      'Baseline',
      'Constrained Baseline',
      'Main',
      'Extended',
      'High',
      'High',
      'High 10',
      'High 4:2:2',
      'High 4:4:4 Predictive',
      'High 10 Intra',
    ],
    hevc: [
      'Main',
      'Main 10',
      'Main 10',
      'Main Still Picture',
      'Rext',
      'Main 4:4:4 12',
    ],
    av1: ['Main', 'High', 'Professional'],
    vp9: ['Profile 0', 'Profile 2'],
  }[codec] ?? ['Simple', 'Main', 'High'];
  const level = {
    h264: [
      0, 9, 10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52, 60,
      61, 62, 255, 256,
    ],
    hevc: [30, 60, 63, 90, 93, 120, 123, 150, 153, 156, 180, 183, 186, 0, 255],
    av1: [0, 1, 4, 5, 8, 9, 12, 13, 16, 17, 31, 32],
  }[codec] ?? [-99, 0, 4, 100];
  const tenBit = hdr || chance(r, 0.12);
  const bitDepth = tenBit
    ? pick(r, [10, 10, 10, 12, 8])
    : pick(r, [8, 8, 8, 10, undefined]);
  const startT = pick(
    r,
    [0, 0, 0, 0.041, 1.4, 1.48, 10, 0.5, -0.08, 600.2, 3.003],
  );
  const v: Obj = {
    streamIndex: pick(r, [0, 0, 0, 0, 1, 2]),
    codec: chance(r, 0.03)
      ? pick(r, ['', 'avc1', 'h265', 'hvc1', 'hev1', 'av01', 'H264'])
      : codec,
    profile: maybe(r, 0.9, () => pick(r, profile)),
    level: maybe(r, 0.9, () =>
      chance(r, 0.9) ? pick(r, level) : int(r, -99, 300),
    ),
    width: maybe(r, 0.97, () => w),
    height: maybe(r, 0.97, () => h),
    displayAspectRatio: maybe(r, 0.7, () =>
      pick(r, ['16:9', '4:3', '2:1', '12:5', '0:1']),
    ),
    pixelFormat: maybe(r, 0.93, () =>
      tenBit
        ? pick(r, [
            'yuv420p10le',
            'yuv420p10le',
            'yuv420p10',
            'p010le',
            'yuv422p10le',
            'yuv420p12le',
          ])
        : pick(r, [
            'yuv420p',
            'yuv420p',
            'nv12',
            'yuv444p',
            'yuv422p',
            'yuvj420p',
          ]),
    ),
    frameRate: maybe(r, 0.95, () =>
      pick(r, [
        '24000/1001',
        '24000/1001',
        '24/1',
        '25/1',
        '30000/1001',
        '30/1',
        '50/1',
        '60/1',
        '60000/1001',
        '120/1',
        '23.976',
        '29.97',
        '25',
        '1000/1',
        '90000/1',
        '0/0',
        '0/1',
        '15/1',
        '12/1',
        '48/1',
        '1/1',
        '24000/1000',
        '48000/1001',
        '7/3',
        '30',
        '0',
        '59.94',
        '119.88',
        '16/1',
        '32/1',
        '64/1',
        '128/1',
      ]),
    ),
    avgFrameRate: maybe(r, 0.6, () =>
      pick(r, ['24000/1001', '25/1', '30/1', '0/0', '60/1']),
    ),
    reorderFrames: maybe(r, 0.6, () => int(r, 0, 4)),
    startTimeSeconds: maybe(r, 0.9, () => startT),
    firstFrameSeconds: maybe(r, 0.5, () =>
      round3(startT + pick(r, [0, 0, 0.041, 0.083, 0.5, 2.002, -0.04])),
    ),
    endSeconds: maybe(r, 0.7, () => round3(int(r, 5, 14000) + r())),
    bitRate: maybe(r, 0.75, () =>
      pick(r, [
        0,
        1,
        9_999,
        10_001,
        int(r, 100_000, 3_000_000),
        int(r, 1_000_000, 40_000_000),
        int(r, 20_000_000, 120_000_000),
        int(r, 500_000, 20_000_000),
      ]),
    ),
    bitDepth,
    colorSpace: maybe(r, 0.9, () =>
      hdr
        ? pick(r, ['bt2020nc', 'bt2020nc', 'bt2020c', 'bt709', 'unknown'])
        : pick(r, [
            'bt709',
            'bt709',
            'smpte170m',
            'bt470bg',
            'unknown',
            'bt2020nc',
          ]),
    ),
    colorTransfer: maybe(r, 0.9, () =>
      hdr
        ? pick(r, ['smpte2084', 'smpte2084', 'arib-std-b67', 'bt709'])
        : pick(r, ['bt709', 'bt709', 'smpte170m', 'iec61966-2-1', 'smpte2084']),
    ),
    colorPrimaries: maybe(r, 0.9, () =>
      hdr
        ? pick(r, ['bt2020', 'bt2020', 'bt709'])
        : pick(r, ['bt709', 'bt709', 'smpte170m', 'bt470bg']),
    ),
    colorRange: maybe(r, 0.85, () =>
      pick(r, ['tv', 'tv', 'tv', 'pc', 'unknown']),
    ),
  };
  // HDR signalling: the static-metadata flavour, then the Dolby Vision record.
  const hdr10 = ['hdr10', 'hdr10plus', 'p81', 'pweird'];
  if (hdr10.includes(scenario) && !(scenario === 'pweird' && chance(r, 0.4)))
    v.hdrFormat = 'HDR10';
  if (
    scenario === 'hlg' ||
    scenario === 'p84' ||
    (scenario === 'pweird' && chance(r, 0.3))
  )
    v.hdrFormat = 'HLG';
  if (chance(r, 0.03)) v.hdrFormat = pick(r, ['HDR10', 'HLG', undefined]);
  if (v.hdrFormat === 'HDR10' && chance(r, 0.8))
    v.hdrMetadata = {
      masteringDisplay:
        'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)',
      maxCll: int(r, 0, 4000),
      maxFall: int(r, 0, 1000),
    };
  if (hdr)
    v.hdr10Plus =
      scenario === 'hdr10plus' ? true : maybe(r, 0.4, () => chance(r, 0.2));
  const dv: Record<string, [number, number[]]> = {
    p5: [5, [0]],
    p7: [7, [6, 1, 2]],
    p81: [8, [1]],
    p84: [8, [4]],
    p82: [8, [2, 0]],
    p10: [10, [0, 1, 2, 4, 6]],
    pweird: [pick(r, [4, 8, 9, 10, 5, 7, 1]), [0, 1, 2, 4, 6, 3]],
  };
  const d = dv[scenario];
  if (d) {
    v.dvProfile = d[0];
    v.dvBlSignalCompatId = maybe(r, 0.9, () => pick(r, d[1]));
    v.dvLevel = maybe(r, 0.85, () => pick(r, [0, 1, 4, 5, 6, 7, 8, 9, 10, 13]));
    v.dvRpuPresent = maybe(r, 0.8, () => chance(r, 0.9));
    v.dvBlPresent = maybe(r, 0.8, () => chance(r, 0.95));
    v.dvElPresent = maybe(r, 0.8, () =>
      d[0] === 7 ? chance(r, 0.85) : chance(r, 0.05),
    );
  }
  if (chance(r, 0.22)) {
    const cw = int(r, 1, w),
      ch = int(r, 1, h);
    v.crop = {
      width: cw,
      height: ch,
      x: int(r, 0, w - cw),
      y: int(r, 0, h - ch),
    };
  }
  // Random perturbations: any field may be missing in a real probe.
  for (const k of Object.keys(v))
    if (k !== 'streamIndex' && k !== 'codec' && chance(r, 0.02)) delete v[k];
  return v;
}

const TITLES = ['', 'Commentary', 'Director', 'English 5.1', 'Descriptive'];

function genAudio(
  r: Rng,
  i: number,
  idx: number,
  vStart: number | undefined,
): Obj {
  const codec = pick(
    r,
    AUDIO_CODECS.concat(['aac', 'aac', 'ac3', 'eac3', 'dts', 'truehd']),
  );
  const channels = chance(r, 0.05)
    ? undefined
    : pick(r, [1, 2, 2, 2, 6, 6, 6, 8, 8, 3, 4, 5, 7, 0, 10, 12]);
  const layout = {
    1: 'mono',
    2: 'stereo',
    3: '3.0',
    4: 'quad',
    5: '5.0(side)',
    6: '5.1(side)',
    7: '6.1',
    8: '7.1',
    0: undefined as unknown as string,
    10: '5.1.4',
    12: '7.1.4',
  }[channels ?? 2];
  const a: Obj = {
    streamIndex: idx,
    codec,
    language:
      i === 0 && chance(r, 0.1) ? 'und' : pick(r, LANGS.slice(0, int(r, 2, 8))),
    languageTag: maybe(r, 0.1, () =>
      pick(r, ['es-419', 'pt-BR', 'zh-Hant', 'en-GB']),
    ),
    title: maybe(r, 0.25, () => pick(r, TITLES)),
    channels,
    channelLayout: maybe(r, 0.85, () => layout),
    sampleRate: maybe(r, 0.9, () =>
      pick(r, [48000, 48000, 48000, 44100, 96000, 32000, 22050, 8000, 192000]),
    ),
    bitRate: maybe(r, 0.75, () =>
      pick(r, [
        0,
        64_000,
        96_000,
        128_000,
        192_000,
        256_000,
        384_000,
        448_000,
        640_000,
        768_000,
        1_509_000,
        1_536_000,
        4_500_000,
        int(r, 8_000, 900_000),
      ]),
    ),
    profile: maybe(r, 0.3, () =>
      pick(r, [
        'LC',
        'HE-AAC',
        'HE-AACv2',
        'DTS-HD MA',
        'DTS',
        'Dolby Digital Plus + Dolby Atmos',
        'Main',
      ]),
    ),
    isDefault: maybe(r, 0.6, () => i === 0 || chance(r, 0.1)),
    startTimeSeconds: maybe(r, 0.8, () =>
      round3(
        (vStart ?? 0) +
          pick(
            r,
            [
              0, 0, 0, 0, 0.02, 0.04, 0.05, 0.051, 0.1, 1.5, -0.1, -0.05,
              0.0499,
            ],
          ),
      ),
    ),
    endSeconds: maybe(r, 0.6, () => round3(int(r, 5, 14000) + r())),
    commentary: maybe(r, 0.08, () => (chance(r, 0.9) ? true : false)),
    audioDescription: maybe(r, 0.05, () => true),
  };
  return a;
}

const SUB_TEXT = ['subrip', 'ass', 'mov_text', 'webvtt', 'srt'];
const SUB_IMG = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'];

function genInfo(
  r: Rng,
  ext: string,
): { info: Obj; videoStart: number | undefined } {
  const nv = chance(r, 0.03) ? 0 : chance(r, 0.04) ? 2 : 1;
  const video = Array.from({ length: nv }, () => genVideo(r));
  const v0 = video[0];
  const vStart = (v0?.firstFrameSeconds ?? v0?.startTimeSeconds) as
    | number
    | undefined;
  const na = chance(r, 0.04) ? 0 : pick(r, [1, 1, 1, 1, 2, 2, 3, 4, 5]);
  let idx = nv;
  const audio = Array.from({ length: na }, (_, i) => {
    idx += chance(r, 0.1) ? int(r, 1, 3) : 0;
    return genAudio(r, i, idx++, vStart);
  });
  const ns = pick(r, [0, 0, 1, 2, 3, 5]);
  const subtitles = Array.from({ length: ns }, (_, i) => {
    const image = chance(r, 0.4);
    return {
      streamIndex: 20 + i,
      codec: pick(r, image ? SUB_IMG : SUB_TEXT),
      language: pick(r, LANGS),
      title: maybe(r, 0.2, () => pick(r, TITLES)),
      forced: chance(r, 0.15),
      hearingImpaired: chance(r, 0.1),
      isImageBased: chance(r, 0.95) ? image : !image,
    };
  });
  const sumBr =
    ((v0?.bitRate as number | undefined) ?? 0) +
    audio.reduce((s, a) => s + ((a.bitRate as number | undefined) ?? 0), 0);
  const fmt = CONTAINERS[ext].fmt;
  const info: Obj = {
    video,
    audio,
    subtitles,
    formatBitRate: maybe(r, 0.85, () =>
      chance(r, 0.8)
        ? Math.max(0, Math.round(sumBr * (0.9 + r() * 0.5))) +
          pick(r, [0, 5_000, 1_000_000])
        : pick(r, [0, 1, 5_000, int(r, 100_000, 90_000_000)]),
    ),
    formatStartSeconds: maybe(r, 0.7, () =>
      pick(r, [0, 0, 0, 1.4, 0.041, 10, -0.08, 1.48, 600.2]),
    ),
    formatName: maybe(r, 0.9, () =>
      chance(r, 0.9)
        ? fmt
        : pick(r, [
            'mpegts',
            'matroska,webm',
            'avi',
            'mov,mp4,m4a,3gp,3g2,mj2',
            'mpegts,foo',
            'MPEGTS',
            'mpegtsraw',
          ]),
    ),
    timestampBreakSeconds: chance(r, 0.15)
      ? chance(r, 0.4)
        ? null
        : round3(int(r, 1, 7200) + r())
      : undefined,
    durationSeconds: maybe(r, 0.9, () => round3(int(r, 1, 14400) + r())),
    chapters: maybe(r, 0.1, () => [
      { startSeconds: 0, endSeconds: 300.5, title: 'Intro' },
    ]),
  };
  return { info, videoStart: vStart };
}

function genScan(
  r: Rng,
  info: Obj,
  videoStart: number | undefined,
): Obj | null {
  if (chance(r, 0.4)) return null;
  const gap = pick(r, [2, 2.002, 3, 3.003, 5, 5.005, 10, 0.5, 1, 7.5, 12.012]);
  const irregular = chance(r, 0.5);
  const n = chance(r, 0.03) ? 0 : pick(r, [1, 2, 3, 5, 12, 40, 100, 400]);
  const base = (videoStart ?? 0) + pick(r, [0, 0, 0.04, -0.04, 1.48, -1, 20]);
  const keyframes: { pts: number; dts: number }[] = [];
  let t = base;
  // First keyframe exactly half a frame before the origin: the grid's own cut-off.
  if (chance(r, 0.1) && videoStart !== undefined)
    t =
      videoStart -
      1 /
        (fpsOf((info.video as Obj[])[0]?.frameRate as string | undefined) ??
          24) /
        2;
  for (let i = 0; i < n; i++) {
    keyframes.push({
      pts: i === 0 && t !== base ? t : round3(t),
      dts: round3(t - pick(r, [0.08, 0.04, 0.125, 0, 0.2])),
    });
    t += irregular ? gap * (0.2 + r() * 2.5) : gap;
  }
  const last = keyframes.length ? keyframes[keyframes.length - 1].pts : base;
  const end = round3(last + pick(r, [0.04, 1, gap, 30, 0, -0.5, 300]));
  const scan: Obj = { keyframes, end };
  if (chance(r, 0.15)) scan.breakSeconds = round3(last + r() * 50);
  const changes: Record<number, boolean> = {};
  for (const a of info.audio as Obj[])
    if (chance(r, 0.85)) changes[a.streamIndex as number] = chance(r, 0.4);
  if (chance(r, 0.1)) changes[int(r, 0, 12)] = chance(r, 0.5);
  scan.audioConfigChanges = changes;
  // An audio track ending on a keyframe boundary: AudioEndsEarly compares with the grid's last segment.
  if (keyframes.length > 1)
    for (const a of info.audio as Obj[])
      if (chance(r, 0.15))
        a.endSeconds = pick(r, keyframes).pts + pick(r, [0, 0, 1e-9, -1e-9]);
  return scan;
}

// --- device ---

const ARCHETYPES = Object.values(DEVICES);

function genDevice(r: Rng): DeviceProfileDto {
  const d: Obj = chance(r, 0.4)
    ? (JSON.parse(JSON.stringify(pick(r, ARCHETYPES))) as Obj)
    : {};
  const mutate = (k: string, v: () => unknown, p: number) => {
    if (chance(r, p) || !(k in d)) {
      const x = v();
      if (x === undefined) delete d[k];
      else d[k] = x;
    }
  };
  const codecs = (pool: string[]) => {
    const l = subset(r, pool, 0.45);
    return chance(r, 0.05) ? l.map((c) => c.toUpperCase()) : l;
  };
  mutate(
    'directPlayProfiles',
    () =>
      Array.from({ length: pick(r, [0, 1, 1, 1, 2, 2, 3, 4]) }, () => ({
        containers: subset(r, [...EXTS, 'matroska', 'mpegts'], 0.3),
        videoCodecs: codecs([
          ...VIDEO_CODECS,
          'avc1',
          'h265',
          'hvc1',
          'hev1',
          'av01',
          'vp8',
        ]),
        audioCodecs: codecs(AUDIO_CODECS),
      })),
    0.5,
  );
  mutate(
    'codecConditions',
    () =>
      maybe(r, 0.75, () =>
        Array.from({ length: pick(r, [0, 1, 2, 3, 4]) }, () => ({
          codec: pick(r, ['h264', 'hevc', 'av1', 'vp9', 'avc1', 'h265']),
          maxLevel: maybe(r, 0.6, () =>
            pick(r, [
              0,
              30,
              40,
              41,
              42,
              50,
              51,
              52,
              62,
              90,
              93,
              120,
              123,
              150,
              153,
              156,
              180,
              186,
              5.1,
              4.1,
              5,
              13,
              31,
              int(r, 1, 255),
            ]),
          ),
          profiles: maybe(r, 0.45, () =>
            subset(
              r,
              [
                'baseline',
                'main',
                'high',
                'high 10',
                'main 10',
                'constrained baseline',
                'extended',
                'high 4:2:2',
                'profile 0',
                'Main',
                'High',
                'professional',
                'rext',
              ],
              0.4,
            ),
          ),
          maxBitDepth: maybe(r, 0.5, () => pick(r, [8, 10, 12, 0, 9])),
          maxWidth: maybe(r, 0.45, () =>
            pick(r, [
              0,
              640,
              1280,
              1920,
              3840,
              4096,
              7680,
              1000,
              int(r, 100, 8000),
            ]),
          ),
          maxHeight: maybe(r, 0.45, () =>
            pick(r, [0, 360, 720, 1080, 2160, 4320, 1000, int(r, 100, 4400)]),
          ),
        })),
      ),
    0.5,
  );
  mutate(
    'maxStreamingBitrate',
    () =>
      maybe(r, 0.5, () =>
        pick(r, [
          0,
          1,
          100,
          1_000_000,
          8_000_000,
          20_000_000,
          40_000_000,
          100_000_000,
          200_000_000,
          int(r, 500_000, 120_000_000),
          8_000_000.5,
        ]),
      ),
    0.4,
  );
  mutate(
    'maxAudioChannels',
    () => maybe(r, 0.7, () => pick(r, [0, 1, 2, 2, 6, 6, 8, 8, 10, 3, 5, 7])),
    0.4,
  );
  mutate(
    'audioChannelsByCodec',
    () =>
      maybe(r, 0.4, () =>
        Object.fromEntries(
          subset(r, [...AUDIO_CODECS, 'AAC'], 0.35).map((c) => [
            c,
            pick(r, [0, 1, 2, 6, 8, 10]),
          ]),
        ),
      ),
    0.4,
  );
  for (const k of [
    'supportsHdr',
    'tonemapsHdrLocally',
    'cropsBlackBarsLocally',
    'supportsDolbyVision',
    'supportsDirectPlay',
    'switchesDirectPlayAudio',
    'supportsHlsSubtitles',
    'dedupesAudioByLanguage',
    'supportsMuxedAudioRendition',
    'supportsIFrameTrickPlay',
    'supportsImageSubtitles',
    'probesSegZero',
    'useTs',
    'useTsOnSingleAudio',
    'supportsAbr',
    'rejectCopy',
    'needsHlsSubtitles',
  ])
    mutate(
      k,
      () =>
        tri(
          r,
          k === 'rejectCopy' || k === 'useTs' ? 0.1 : 0.4,
          k === 'supportsDirectPlay' ? 0.15 : 0.3,
        ),
      0.35,
    );
  mutate(
    'dolbyVisionProfiles',
    () => maybe(r, 0.6, () => subset(r, [4, 5, 7, 8, 9, 10], 0.4)),
    0.4,
  );
  mutate('deviceType', () => pick(r, ['mobile', 'desktop', undefined]), 0.3);
  mutate(
    'deviceName',
    () =>
      maybe(r, 0.8, () => pick(r, ['Chrome', 'Shield TV', 'iPhone', 'Cast'])),
    0.2,
  );
  mutate(
    'systemName',
    () => maybe(r, 0.8, () => pick(r, ['Linux', 'Android', 'iOS', 'tvOS'])),
    0.2,
  );
  mutate(
    'appVersion',
    () => maybe(r, 0.6, () => pick(r, ['1.0.0', '2.3.4'])),
    0.2,
  );
  return wireDevice(d as unknown as DeviceProfileDto);
}

// --- host caps, config, selection ---

function genHostCaps(r: Rng): HostCaps {
  const platform = pick(r, [
    'linux',
    'linux',
    'linux',
    'darwin',
    'win32',
    'win32',
  ] as const);
  const hwAccel = pick(
    r,
    platform === 'linux'
      ? (['none', 'vaapi', 'nvenc', 'qsv', 'vaapi', 'qsv'] as const)
      : platform === 'darwin'
        ? (['videotoolbox', 'videotoolbox', 'none'] as const)
        : (['none', 'nvenc', 'qsv', 'amf', 'amf', 'qsv'] as const),
  );
  const likely: Partial<Record<string, ProbeName[]>> = {
    vaapi: [
      'tonemapOpencl',
      'tonemapOpenclCrop',
      'tonemapOpenclHdr10',
      'vulkan',
    ],
    nvenc: ['cuda', 'cudaHdr10', 'opencl', 'openclHdr10'],
    qsv: [
      'tonemapOpencl',
      'tonemapOpenclHdr10',
      'vppQsv',
      'qsvOpencl',
      'qsvOpenclHdr10',
    ],
    amf: ['amfOpencl', 'opencl', 'openclHdr10'],
  };
  const probes = chance(r, 0.4)
    ? subset(r, PROBES, 0.5)
    : subset(r, likely[hwAccel] ?? PROBES, 0.8);
  return {
    hwAccel,
    platform,
    libfdkAac: chance(r, 0.4),
    vaapiWritesHdrMetadata: chance(r, 0.5),
    probes,
    disabledEncoders: chance(r, 0.8) ? [] : subset(r, ENCODERS, 0.08),
    disabledDecoders: chance(r, 0.85) ? [] : subset(r, DECODERS, 0.2),
  };
}

function genSelection(r: Rng, info: Obj): Obj {
  const n = (info.audio as unknown[]).length;
  const subs = info.subtitles as Obj[];
  const sel: Obj = {};
  if (chance(r, 0.7))
    sel.tokenParam = pick(r, [
      '?token=abc',
      '?t=1&x=2',
      '?token=a%20b',
      '',
      '?q=1',
    ]);
  const quality = r();
  sel.requestedQuality =
    quality < 0.3
      ? undefined
      : quality < 0.4
        ? 'auto'
        : quality < 0.55
          ? 'original'
          : quality < 0.9
            ? pick(r, RUNGS)
            : pick(r, ODD_QUALITIES);
  if (chance(r, 0.3)) {
    sel.burnInSubtitleId = chance(r, 0.1)
      ? 0
      : subs.length && chance(r, 0.8)
        ? pick(r, subs).streamIndex
        : int(r, 1, 40);
    if (chance(r, 0.95)) sel.burnInIsText = chance(r, 0.6);
  }
  if (chance(r, 0.45))
    sel.audioStreamIndex =
      chance(r, 0.75) && n ? int(r, 0, n - 1) : pick(r, [n, n + 3, -1, 99, 0]);
  return sel;
}

function genConfig(r: Rng): VectorConfig {
  return {
    autoCropEnabled: chance(r, 0.5),
    tonemapAlgo: pick(r, ['auto', 'auto', 'opencl', 'vaapi', 'qsv']),
    autoQualityMode: chance(r, 0.35) ? 'abr' : 'directplay',
    segmentDuration: pick(
      r,
      [3, 3, 3, 1, 2, 4, 5, 6, 10, 0.5, 1.5, 2.002, 7.5, 12, 0.1, 3.003, 30],
    ),
  };
}

const sum = (xs: Obj[], k: string) =>
  xs.reduce((a, x) => a + ((x[k] as number | undefined) ?? 0), 0);
const jsRound = (x: number) => Math.floor(x + 0.5);

/** Frame rate of an ffprobe `a/b` (or decimal) string, undefined when unusable. */
function fpsOf(rate: string | undefined): number | undefined {
  const [a, b] = (rate ?? '').split('/').map(Number);
  const fps = b === undefined ? a : b > 0 ? a / b : 0;
  return fps > 0 ? fps : undefined;
}

/** Moves values onto the exact edges the decision compares (bitrate derivations, Mbps rounding,
 *  segment counting, audio end vs last segment), where a one-ulp or one-unit port slip shows. */
function sharpenEdges(
  r: Rng,
  info: Obj,
  device: DeviceProfileDto,
  cfg: VectorConfig,
): void {
  const v0 = (info.video as Obj[])[0];
  const audio = info.audio as Obj[];
  // A Dolby Vision source a DV client can take as is: reaches the remux codec-string checks.
  if (v0?.dvProfile && chance(r, 0.5)) {
    Object.assign(v0, {
      colorRange: 'tv',
      colorSpace: 'bt2020nc',
      pixelFormat: 'yuv420p10le',
      dvLevel: pick(r, [1, 6, 9]),
      dvBlSignalCompatId: pick(r, [1, 4, 0]),
      hdrFormat: pick(r, ['HDR10', 'HLG']),
    });
    device.dolbyVisionProfiles = [5, 7, 8, 10];
    device.supportsHdr = true;
  }
  if (v0 && chance(r, 0.12)) {
    delete v0.bitRate;
    info.formatBitRate =
      sum(audio, 'bitRate') +
      pick(r, [9_999, 10_000, 10_001, 5_000_000, 500_001]);
  }
  if (v0 && audio.length && chance(r, 0.1)) {
    v0.bitRate = pick(r, [1_000_000, 8_000_001, 12_345_679]);
    info.formatBitRate =
      (v0.bitRate as number) + pick(r, [999, 1000, 1001, 640_000]);
    for (const a of audio) delete a.bitRate;
  }
  if (chance(r, 0.1)) {
    const total = 500_000 * int(r, 1, 120);
    info.formatBitRate = total;
    device.maxStreamingBitrate = total + pick(r, [-1, 0, 1, -500_000]);
  }
  if (v0 && chance(r, 0.15)) {
    const fps = fpsOf(v0.frameRate as string | undefined);
    const origin = (v0.firstFrameSeconds ?? v0.startTimeSeconds ?? 0) as number;
    const seg =
      chance(r, 0.5) || !fps
        ? cfg.segmentDuration
        : jsRound(
            (Math.max(1, jsRound(cfg.segmentDuration * fps)) / fps) * 1000,
          ) / 1000;
    const k = int(r, 1, 300);
    const end =
      origin +
      k * seg +
      1 / (fps ?? 24) +
      pick(r, [0, 0, -1e-10, 1e-10, -5e-10, -2e-9, 1e-9, -1e-9]);
    v0.endSeconds = end;
    delete info.timestampBreakSeconds;
    for (const a of audio)
      if (chance(r, 0.5))
        a.endSeconds =
          origin + (k - 1) * seg + pick(r, [0, 0, 1e-9, -1e-9, 0.001, -0.001]);
  }
}

/** Half the devices are bent to list the source's container and codecs, so DirectPlay and its
 *  per-condition failures are reached; the rest stay independent. */
function fitDevice(
  r: Rng,
  d: DeviceProfileDto,
  info: Obj,
  ext: string,
  easy: boolean,
): DeviceProfileDto {
  if (!easy && chance(r, 0.5)) return d;
  const v0 = (info.video as Obj[])[0];
  const audio = info.audio as Obj[];
  if (!d.directPlayProfiles.length)
    d.directPlayProfiles = [
      { containers: [], videoCodecs: [], audioCodecs: [] },
    ];
  const p = pick(r, d.directPlayProfiles);
  const add = (xs: string[], x: unknown) => {
    if (typeof x === 'string' && !xs.includes(x) && chance(r, 0.9)) xs.push(x);
  };
  add(p.containers, ext);
  add(p.videoCodecs, v0?.codec);
  for (const a of audio) add(p.audioCodecs, a.codec);
  if (chance(r, 0.5)) d.maxAudioChannels = pick(r, [6, 8]);
  if (easy) {
    for (const k of [
      'rejectCopy',
      'needsHlsSubtitles',
      'useTs',
      'useTsOnSingleAudio',
      'supportsDirectPlay',
      'switchesDirectPlayAudio',
      'dedupesAudioByLanguage',
    ] as const)
      delete d[k];
    d.maxAudioChannels = 8;
    delete d.audioChannelsByCodec;
    delete d.maxStreamingBitrate;
    if (chance(r, 0.6)) delete d.codecConditions;
  }
  return d;
}

/** One random, wire-valid decision input; the same (seed, i) always yields the same vector. */
export function genVector(r: Rng, name: string): Vector {
  const easy = chance(r, 0.3);
  const ext = pick(r, ['mkv', 'mkv', 'mkv', 'mp4', 'mp4', 'ts', ...EXTS]);
  const e = chance(r, 0.05) ? ext.toUpperCase() : ext;
  const { info, videoStart } = genInfo(r, ext);
  const device = fitDevice(r, genDevice(r), info, ext, easy);
  const selection = genSelection(r, info);
  const config = genConfig(r);
  sharpenEdges(r, info, device, config);
  const scan = genScan(r, info, videoStart);
  if (easy) {
    delete selection.burnInSubtitleId;
    delete selection.burnInIsText;
    selection.requestedQuality = pick(r, [undefined, 'auto', 'original']);
    if (selection.audioStreamIndex !== undefined)
      selection.audioStreamIndex = 0;
    config.autoQualityMode = 'directplay';
  }
  return {
    name,
    source: 'fuzz',
    input: {
      media: {
        mediaFileId: int(r, 1, 2_000_000),
        path: `/media/${pick(r, ['movie', 'a b', 'ü-é'])}.${e}`,
        ext: `.${e}`,
        contentType: CONTAINERS[ext].mime,
      },
      info: wireInfo(info as never),
      scan: wireScan(scan as never),
      device,
      selection: selection as never,
    },
    hostCaps: genHostCaps(r),
    config,
  };
}
