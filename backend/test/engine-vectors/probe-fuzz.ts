import { mulberry32 } from './fuzz';
import type { SynthCase } from './probe-synthetic';
import { responder, type Tools } from './probe-synthetic';

type Rng = () => number;
type O = Record<string, unknown>;
const int = (r: Rng, lo: number, hi: number) =>
  lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rng, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)];
const chance = (r: Rng, p: number) => r() < p;
const maybe = <T>(r: Rng, p: number, v: () => T): T | undefined =>
  chance(r, p) ? v() : undefined;

const CODECS = [
  'h264',
  'hevc',
  'vp9',
  'av1',
  'mpeg2video',
  'mjpeg',
  'png',
  'aac',
  'ac3',
  'eac3',
  'flac',
  'opus',
  'dts',
  'truehd',
  'subrip',
  'ass',
  'webvtt',
  'mov_text',
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'dvb_subtitle',
  'xsub',
  'bin_data',
  undefined,
];
const TYPES = [
  'video',
  'video',
  'audio',
  'audio',
  'audio',
  'subtitle',
  'subtitle',
  'data',
  'attachment',
  undefined,
];
const LANGS = [
  'eng',
  'fre',
  'ENG',
  'und',
  'UND',
  '',
  'jpn',
  'zh-Hant',
  'por',
  'xx',
];
const TITLES = [
  'Main',
  'French AC3 5.1',
  'English SDH',
  'Forced',
  'non-forced',
  'not forced',
  'Commentary',
  'Deutsch',
  'Español',
  'Closed Captions',
  'Foreign Parts',
  'Descriptions',
  'pt-BR',
  'Japanese 2.0',
  '',
];
const RATES = [
  '24000/1001',
  '25/1',
  '30/1',
  '0/0',
  '0/1',
  '25',
  '50/1',
  '1000/1',
  '-25/1',
  'abc',
  '60000/1001',
  '15/2',
  '500/21',
  '1/0',
];
const BASES = [
  '1/1000',
  '1/90000',
  '1/24',
  '1001/24000',
  '0/1',
  '1/0',
  'x',
  '1/48000',
];
const NUM_STR = [
  '0',
  '0.000000',
  '1.5',
  '2.04',
  '10.5',
  '123.456789',
  '-0.5',
  '3600',
  '7261.4',
  '0.041',
];
const IETF = [
  'es-419',
  'pt-BR',
  'en',
  'und-Latn',
  'zh-Hant',
  'fr-CA-x',
  'UND-419',
  'de-DE-1996',
  'es-419',
  'pt-BR',
  undefined,
];
const FORMATS = [
  'matroska,webm',
  'mov,mp4,m4a,3gp,3g2,mj2',
  'mpegts',
  'avi',
  'flac',
  'matroska',
  'ogg',
];

function tags(r: Rng): O | undefined {
  if (!chance(r, 0.8)) return undefined;
  const t: O = {};
  if (chance(r, 0.7))
    t[pick(r, ['language', 'LANGUAGE', 'Language'])] = pick(r, LANGS);
  if (chance(r, 0.5)) t[pick(r, ['title', 'TITLE', 'Title'])] = pick(r, TITLES);
  if (chance(r, 0.3))
    t[pick(r, ['DURATION', 'duration'])] = pick(r, [
      '00:01:02.500000000',
      '1:02:03',
      '00:00:3.0',
      '12',
      '00:00:03',
      '00:00:03.',
    ]);
  if (chance(r, 0.15))
    t.rotate = pick(r, ['90', '270', '-90', 'abc', '', '180']);
  if (chance(r, 0.15)) t[pick(r, ['language', 'LANGUAGE'])] = pick(r, LANGS);
  return t;
}

function sideData(r: Rng): O[] | undefined {
  if (!chance(r, 0.3)) return undefined;
  const out: O[] = [];
  if (chance(r, 0.4))
    out.push({
      side_data_type: 'Display Matrix',
      rotation: pick(r, [90, -90, 180, 270, 0, 45]),
    });
  if (chance(r, 0.4))
    out.push({
      side_data_type: 'DOVI configuration record',
      dv_profile: pick(r, [4, 5, 7, 8, 10]),
      dv_level: int(r, 1, 13),
      rpu_present_flag: int(r, 0, 1),
      el_present_flag: int(r, 0, 1),
      bl_present_flag: int(r, 0, 1),
      dv_bl_signal_compatibility_id: int(r, 0, 6),
    });
  if (chance(r, 0.2)) out.push({ side_data_type: 'x', dv_profile: 'eight' });
  return out;
}

function stream(r: Rng, index: number): O {
  const type = pick(r, TYPES);
  const s: O = {
    index,
    codec_type: type,
    codec_name: pick(r, CODECS),
    profile: maybe(r, 0.5, () =>
      pick(r, [
        'High',
        'Main 10',
        'LC',
        'DTS-HD MA',
        'Dolby Digital Plus + Dolby Atmos',
      ]),
    ),
    level: maybe(r, 0.5, () => pick(r, [-99, 30, 41, 51, 153])),
    width: maybe(r, 0.8, () => pick(r, [0, 160, 480, 1280, 1920, 3840])),
    height: maybe(r, 0.8, () => pick(r, [0, 90, 270, 720, 1080, 2160])),
    display_aspect_ratio: maybe(r, 0.4, () => '16:9'),
    pix_fmt: maybe(r, 0.6, () => pick(r, ['yuv420p', 'yuv420p10le'])),
    r_frame_rate: maybe(r, 0.8, () => pick(r, RATES)),
    avg_frame_rate: maybe(r, 0.8, () => pick(r, RATES)),
    has_b_frames: maybe(r, 0.5, () => int(r, 0, 5)),
    time_base: maybe(r, 0.8, () => pick(r, BASES)),
    start_time: maybe(r, 0.7, () => pick(r, NUM_STR)),
    duration: maybe(r, 0.5, () => pick(r, NUM_STR)),
    bit_rate: maybe(r, 0.5, () => pick(r, ['0', '128000', '5000000', '1e3'])),
    bits_per_raw_sample: maybe(r, 0.4, () => pick(r, ['8', '10', '', '0'])),
    color_space: maybe(r, 0.3, () => 'bt2020nc'),
    color_transfer: maybe(r, 0.5, () =>
      pick(r, ['smpte2084', 'arib-std-b67', 'bt709', 'unknown']),
    ),
    color_primaries: maybe(r, 0.5, () => pick(r, ['bt2020', 'bt709'])),
    color_range: maybe(r, 0.3, () => 'tv'),
    side_data_list: sideData(r),
    channels: maybe(r, 0.7, () => pick(r, [0, 1, 2, 6, 8])),
    channel_layout: maybe(r, 0.5, () =>
      pick(r, ['mono', 'stereo', '5.1(side)', '7.1', '']),
    ),
    sample_rate: maybe(r, 0.7, () =>
      pick(r, ['48000', '44100', '0', 'abc', '']),
    ),
    tags: tags(r),
    disposition: maybe(r, 0.8, () => ({
      default: int(r, 0, 1),
      forced: int(r, 0, 1),
      hearing_impaired: int(r, 0, 1),
      attached_pic: chance(r, 0.1) ? 1 : 0,
      comment: int(r, 0, 1),
      visual_impaired: int(r, 0, 1),
      descriptions: int(r, 0, 1),
    })),
  };
  return s;
}

const packets = (r: Rng, n: number, interval: number, from: number) =>
  Array.from({ length: n }, (_, i) => (from + i * interval).toFixed(6)).join(
    '\n',
  ) + '\n';

const cropLine = (w: number, h: number, x: number, y: number) =>
  `[Parsed_cropdetect_1 @ 0x1] crop=${w}:${h}:${x}:${y}\n`;

function tools(r: Rng): Tools {
  const n = int(r, 0, 6);
  const streams = Array.from({ length: n }, (_, i) => stream(r, i));
  const chapters = maybe(r, 0.5, () =>
    Array.from({ length: int(r, 0, 4) }, () => ({
      start_time: maybe(r, 0.9, () => pick(r, NUM_STR)),
      end_time: maybe(r, 0.9, () => pick(r, NUM_STR)),
      tags: maybe(r, 0.5, () => ({
        [pick(r, ['title', 'TITLE'])]: pick(r, TITLES),
      })),
    })),
  );
  const duration = maybe(r, 0.9, () =>
    pick(r, ['3', '60.5', '89.99', '90', '3600', '7261.4']),
  );
  const main = JSON.stringify({
    streams,
    format: {
      format_name: maybe(r, 0.9, () => pick(r, FORMATS)),
      start_time: maybe(r, 0.8, () => pick(r, NUM_STR)),
      duration,
      bit_rate: maybe(r, 0.8, () => pick(r, ['0', '5000000', '1e6'])),
    },
    chapters,
  });
  const side = [
    {
      side_data_type: 'Mastering display metadata',
      red_x: pick(r, ['35400/50000', 0.708, '1/3']),
      red_y: '14600/50000',
      green_x: '8500/50000',
      green_y: '39850/50000',
      blue_x: '6550/50000',
      blue_y: '2300/50000',
      white_point_x: '15635/50000',
      white_point_y: pick(r, ['16450/50000', '1/0', undefined]),
      min_luminance: pick(r, ['1/10000', 0.005, '1/20000']),
      max_luminance: pick(r, ['10000000/10000', 1000, '3/20000']),
    },
    {
      side_data_type: 'Content light level metadata',
      max_content: pick(r, [1000, '1100', 'x', undefined]),
      max_average: pick(r, [400, '350', undefined]),
    },
    { side_data_type: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' },
  ].filter(() => chance(r, 0.8));
  const frames = chance(r, 0.15)
    ? []
    : [
        {
          pts: maybe(r, 0.8, () => int(r, -100, 200000)),
          best_effort_timestamp: maybe(r, 0.6, () => int(r, 0, 5000)),
          side_data_list: maybe(r, 0.8, () => side),
        },
      ];
  const audioLines =
    Array.from(
      { length: int(r, 0, 12) },
      () =>
        `${int(r, 0, n)},${chance(r, 0.1) ? 'N/A' : (r() * 200).toFixed(3)}`,
    ).join('\n') + '\n';
  const w = pick(r, [480, 1920]);
  const crops: Record<number, string> = {};
  for (const ss of [
    0, 1, 2, 3, 4, 5, 6, 8, 9, 11, 15, 18, 27, 30, 36, 48, 90, 180, 270, 360,
    363, 480, 1089, 1800, 2178, 3267, 4356, 5809,
  ]) {
    if (chance(r, 0.85))
      crops[ss] = cropLine(
        w,
        pick(r, [190, 254, 800, 1080]),
        0,
        pick(r, [0, 8, 40, 140]),
      );
  }
  return {
    main,
    fps: chance(r, 0.8)
      ? packets(
          r,
          int(r, 0, 300),
          pick(r, [0, 0.001, 0.04, 0.0417, 0.0416667, 0.02]),
          int(r, 0, 3600),
        )
      : { fail: { code: 1 } },
    frames: chance(r, 0.1) ? { fail: { code: 1 } } : frames,
    audio: chance(r, 0.9) ? audioLines : { fail: { code: 1 } },
    late: chance(r, 0.7)
      ? {
          streams: Array.from({ length: int(r, 0, 3) }, () => ({
            index: int(r, 0, n),
            channels: pick(r, [0, 2, 6, undefined]),
            channel_layout: pick(r, ['stereo', '5.1', '', undefined]),
            sample_rate: pick(r, ['48000', '0', '-1', undefined]),
          })),
        }
      : { fail: { code: 1 } },
    mkv: chance(r, 0.75)
      ? {
          tracks: [
            ...streams.flatMap((st) =>
              chance(r, 0.7)
                ? [
                    {
                      id: st.index,
                      type: chance(r, 0.9)
                        ? st.codec_type === 'subtitle'
                          ? 'subtitles'
                          : st.codec_type
                        : 'audio',
                      properties: { language_ietf: pick(r, IETF) },
                    },
                  ]
                : [],
            ),
            ...Array.from({ length: int(r, 0, 2) }, () => ({
              id: int(r, 0, n),
              type: pick(r, ['audio', 'subtitles', 'video']),
              properties: { language_ietf: pick(r, IETF) },
            })),
          ],
        }
      : pick(r, [
          { fail: { enoent: true } },
          {
            fail: { code: 1 },
            stdout:
              '{"tracks":[{"id":1,"type":"audio","properties":{"language_ietf":"fr-CA"}}]}',
          },
          'garbage',
        ]),
    crop: chance(r, 0.2) ? { fail: { code: 1 } } : crops,
  };
}

/** Random ffprobe outputs (types and values the tools really print, plus awkward ones). */
export function fuzzCases(seed: number, count: number): SynthCase[] {
  const r = mulberry32(seed);
  return Array.from({ length: count }, (_, i) => ({
    name: `fuzz ${seed} ${i}`,
    opts: { crop: chance(r, 0.8), mkvTags: true },
    fileSize: int(r, 1000, 3_000_000_000),
    backend: responder(tools(r)),
  }));
}
