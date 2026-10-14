import type { Backend, ToolResult } from './probe-io';

type Fail = {
  fail: NonNullable<ToolResult['fail']>;
  stderr?: string;
  stdout?: string;
};
type R = string | object | Fail;

/** Canned answers of the tools of one probe, by role. */
export interface Tools {
  main?: R;
  fps?: R;
  /** Frames of the first-frame dump (ffprobe `-of json` wraps them in `frames`). */
  frames?: object[] | Fail;
  audio?: R;
  late?: R;
  mkv?: R;
  /** cropdetect stderr by `-ss`, or one answer for all. */
  crop?: Record<number, R> | R;
}

export interface SynthCase {
  name: string;
  opts: { crop: boolean; mkvTags: boolean };
  fileSize: number;
  backend: Backend;
}

const isFail = (r: unknown): r is Fail =>
  !!r && typeof r === 'object' && 'fail' in r;
const result = (r: R | undefined): ToolResult => {
  if (r === undefined)
    return { stdout: '', stderr: 'no canned answer', fail: { code: 1 } };
  if (isFail(r))
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', fail: r.fail };
  return { stdout: typeof r === 'string' ? r : JSON.stringify(r), stderr: '' };
};

export function responder(t: Tools): Backend {
  return (cmd, args) => {
    const a = args.join(' ');
    let r: ToolResult;
    if (cmd === 'mkvmerge') r = result(t.mkv);
    else if (cmd === 'ffmpeg') {
      const ss = Number(args[args.indexOf('-ss') + 1]);
      const c = t.crop;
      const pick =
        typeof c === 'object' && c !== null && !isFail(c)
          ? (c as Record<number, R>)[ss]
          : c;
      r = result(pick);
      if (!r.fail) r = { stdout: '', stderr: r.stdout };
    } else if (a.includes('-show_chapters')) r = result(t.main);
    else if (a.includes('-read_intervals')) r = result(t.fps);
    else if (a.includes('frame=')) {
      r = Array.isArray(t.frames)
        ? {
            stdout: JSON.stringify({ frames: t.frames }, null, 4) + '\n',
            stderr: '',
          }
        : result(t.frames);
    } else if (a.includes('packet=stream_index')) r = result(t.audio);
    else if (a.includes('-analyzeduration')) r = result(t.late);
    else r = result(undefined);
    const path = args[args.length - 1];
    r = { ...r, stderr: r.stderr.split('{path}').join(path) };
    return Promise.resolve(r);
  };
}

type O = Record<string, unknown>;
const video = (o: O = {}): O => ({
  index: 0,
  codec_name: 'h264',
  codec_type: 'video',
  profile: 'High',
  level: 41,
  width: 1920,
  height: 1080,
  display_aspect_ratio: '16:9',
  pix_fmt: 'yuv420p',
  r_frame_rate: '24000/1001',
  avg_frame_rate: '24000/1001',
  has_b_frames: 2,
  time_base: '1/1000',
  start_time: '0.000000',
  bits_per_raw_sample: '8',
  ...o,
});
const audio = (o: O = {}): O => ({
  index: 1,
  codec_name: 'aac',
  codec_type: 'audio',
  channels: 2,
  channel_layout: 'stereo',
  sample_rate: '48000',
  time_base: '1/1000',
  start_time: '0.000000',
  bit_rate: '128000',
  disposition: { default: 1 },
  tags: { language: 'eng' },
  ...o,
});
const sub = (o: O = {}): O => ({
  index: 2,
  codec_name: 'subrip',
  codec_type: 'subtitle',
  disposition: { default: 0 },
  tags: { language: 'eng' },
  ...o,
});
const hdr = (o: O = {}): O =>
  video({
    codec_name: 'hevc',
    profile: 'Main 10',
    pix_fmt: 'yuv420p10le',
    bits_per_raw_sample: '10',
    color_space: 'bt2020nc',
    color_transfer: 'smpte2084',
    color_primaries: 'bt2020',
    color_range: 'tv',
    ...o,
  });
const main = (streams: O[], format: O = {}, chapters?: O[]): string =>
  JSON.stringify({
    streams,
    format: {
      format_name: 'matroska,webm',
      start_time: '0.000000',
      duration: '60.000000',
      bit_rate: '5000000',
      ...format,
    },
    ...(chapters ? { chapters } : {}),
  });

const mastering = (o: O = {}): O => ({
  side_data_type: 'Mastering display metadata',
  red_x: '35400/50000',
  red_y: '14600/50000',
  green_x: '8500/50000',
  green_y: '39850/50000',
  blue_x: '6550/50000',
  blue_y: '2300/50000',
  white_point_x: '15635/50000',
  white_point_y: '16450/50000',
  min_luminance: '1/10000',
  max_luminance: '10000000/10000',
  ...o,
});
const light = (o: O = {}): O => ({
  side_data_type: 'Content light level metadata',
  max_content: 1000,
  max_average: 400,
  ...o,
});
const frame = (side: O[] = [], o: O = {}): O => ({
  pts: 0,
  best_effort_timestamp: 0,
  side_data_list: side,
  ...o,
});
const dovi = (o: O = {}): O => ({
  side_data_type: 'DOVI configuration record',
  dv_version_major: 1,
  dv_version_minor: 0,
  dv_profile: 8,
  dv_level: 6,
  rpu_present_flag: 1,
  el_present_flag: 0,
  bl_present_flag: 1,
  dv_bl_signal_compatibility_id: 1,
  ...o,
});

/** `n` packet times at `interval` seconds from `from`, one per line. */
const packets = (n: number, interval: number, from = 0) =>
  Array.from({ length: n }, (_, i) => (from + i * interval).toFixed(6)).join(
    '\n',
  ) + '\n';
const lines = (...l: string[]) => l.join('\n') + '\n';
const crop = (w: number, h: number, x: number, y: number) =>
  `[Parsed_cropdetect_1 @ 0x55d5] x1:${x} x2:${w + x - 1} y1:${y} y2:${h + y - 1} w:${w} h:${h} x:${x} y:${y} pts:100 t:1.0 limit:0.094118 crop=${w}:${h}:${x}:${y}\n`;
const mkv = (...tracks: [number, string, string, string?][]) =>
  JSON.stringify({
    tracks: tracks.map(([id, type, ietf, lang]) => ({
      id,
      type,
      properties: { language: lang ?? 'und', language_ietf: ietf },
    })),
  });

const both = { crop: true, mkvTags: true };
const c = (
  name: string,
  tools: Tools,
  fileSize = 123_456_789,
  opts = both,
): SynthCase => ({
  name,
  opts,
  fileSize,
  backend: responder(tools),
});
const sameCrop = (w: number, h: number, x: number, y: number) =>
  crop(w, h, x, y);
const AUDIO_PACKETS = lines(
  '0,0.000000',
  '1,0.000000',
  '0,0.041000',
  '1,0.021000',
);

export function syntheticCases(): SynthCase[] {
  const base = { audio: AUDIO_PACKETS, frames: [frame()] };
  return [
    // Dolby Vision records, HDR10 static metadata and HDR10+.
    c('dv profile 8.1 with hdr10 metadata', {
      ...base,
      main: main([hdr({ side_data_list: [dovi()] }), audio()]),
      frames: [
        frame([
          mastering(),
          light(),
          { side_data_type: 'Dolby Vision RPU Data' },
        ]),
      ],
    }),
    c('dv profile 5 no transfer', {
      ...base,
      main: main([
        video({
          codec_name: 'hevc',
          side_data_list: [
            dovi({ dv_profile: 5, dv_bl_signal_compatibility_id: 0 }),
          ],
        }),
        audio(),
      ]),
    }),
    c('dv profile 7 dual layer', {
      ...base,
      main: main([
        hdr({
          side_data_list: [
            dovi({
              dv_profile: 7,
              el_present_flag: 1,
              dv_bl_signal_compatibility_id: 6,
            }),
          ],
        }),
        audio(),
      ]),
    }),
    c('dv record without flags', {
      ...base,
      main: main([
        hdr({ side_data_list: [{ side_data_type: 'x', dv_profile: 4 }] }),
        audio(),
      ]),
    }),
    c('hdr10 decimal metadata', {
      ...base,
      main: main([hdr(), audio()]),
      frames: [
        frame([
          mastering({
            red_x: 0.708,
            red_y: 0.292,
            green_x: 0.17,
            green_y: 0.797,
            blue_x: 0.131,
            blue_y: 0.046,
            white_point_x: 0.3127,
            white_point_y: 0.329,
            min_luminance: 0.005,
            max_luminance: 1000,
          }),
          light({ max_content: '1100', max_average: '350' }),
        ]),
      ],
    }),
    c('hdr10 rational rounding', {
      ...base,
      main: main([hdr(), audio()]),
      frames: [
        frame([
          mastering({
            red_x: '1/3',
            green_x: '5/3',
            min_luminance: '1/3',
            max_luminance: '5/2',
          }),
          light({ max_content: 'x' }),
        ]),
      ],
    }),
    c('hdr10 incomplete metadata', {
      ...base,
      main: main([hdr(), audio()]),
      frames: [frame([mastering({ white_point_y: undefined })])],
    }),
    c('hdr10 rounding ties', {
      ...base,
      main: main([hdr(), audio()]),
      frames: [
        frame([
          mastering({
            red_x: '1/100000',
            green_x: 0.00003,
            blue_x: '3/100000',
            min_luminance: '1/20000',
            max_luminance: '3/20000',
            white_point_x: 0.00001,
            white_point_y: '5/100000',
          }),
        ]),
      ],
    }),
    c('hdr10 zero denominator', {
      ...base,
      main: main([hdr(), audio()]),
      frames: [frame([mastering({ red_x: '1/0' })])],
    }),
    c('hdr10 without content light', {
      ...base,
      main: main([hdr(), audio()]),
      frames: [frame([mastering()])],
    }),
    c('hdr10 plus hybrid', {
      ...base,
      main: main([hdr(), audio()]),
      frames: [
        frame([
          mastering(),
          light(),
          { side_data_type: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' },
        ]),
      ],
    }),
    c('hlg with mastering display', {
      ...base,
      main: main([hdr({ color_transfer: 'arib-std-b67' }), audio()]),
      frames: [frame([mastering()])],
    }),
    c('pq without bt2020', {
      ...base,
      main: main([hdr({ color_primaries: 'bt709' }), audio()]),
    }),
    c('hdr10 first frame fails', {
      ...base,
      main: main([hdr(), audio()]),
      frames: { fail: { code: 1 }, stderr: 'boom' },
    }),
    c('hdr10 no frame in dump', {
      ...base,
      main: main([hdr(), audio()]),
      frames: [],
    }),
    // Rotation.
    c('rotation matrix 90', {
      ...base,
      main: main([
        video({
          side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }],
        }),
        audio(),
      ]),
    }),
    c('rotation matrix minus 90', {
      ...base,
      main: main([
        video({
          side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
        }),
        audio(),
      ]),
    }),
    c('rotation matrix 180', {
      ...base,
      main: main([
        video({
          side_data_list: [{ side_data_type: 'Display Matrix', rotation: 180 }],
        }),
        audio(),
      ]),
    }),
    c('rotation tag 270', {
      ...base,
      main: main([video({ tags: { rotate: '270' } }), audio()]),
    }),
    c('rotation tag invalid', {
      ...base,
      main: main([video({ tags: { rotate: 'abc' } }), audio()]),
    }),
    c('rotation matrix wins over tag', {
      ...base,
      main: main([
        video({ tags: { rotate: '90' }, side_data_list: [{ rotation: 0 }] }),
        audio(),
      ]),
    }),
    // Programme stream selection.
    c('cover art muxed first', {
      ...base,
      main: main([
        video({
          index: 0,
          codec_name: 'mjpeg',
          disposition: { attached_pic: 1 },
        }),
        video({ index: 1 }),
        audio({ index: 2 }),
      ]),
    }),
    c('still beside moving video', {
      ...base,
      main: main([
        video({ index: 0, codec_name: 'PNG' }),
        video({ index: 1 }),
        audio({ index: 2 }),
      ]),
    }),
    c('only stills', {
      ...base,
      main: main([video({ index: 0, codec_name: 'png' }), audio()]),
    }),
    c('only attached pictures', {
      ...base,
      main: main([
        video({
          index: 0,
          codec_name: 'mjpeg',
          disposition: { attached_pic: 1 },
        }),
        audio(),
      ]),
    }),
    c('two video streams', {
      ...base,
      main: main([
        video(),
        video({ index: 1, width: 1280, height: 720, codec_name: 'hevc' }),
        audio({ index: 2 }),
      ]),
    }),
    c('audio only', {
      audio: lines('0,0.000000'),
      main: main([audio({ index: 0 })]),
    }),
    c('no streams', {
      main: main([], { bit_rate: '0' }, [
        { start_time: '0.0', end_time: '5.0', tags: { title: 'x' } },
      ]),
    }),
    c('subtitles only', {
      main: main([sub({ index: 0 })], { start_time: 'N/A', duration: '2.9' }),
    }),
    c('ffprobe fails with stderr', {
      main: {
        fail: { code: 1 },
        stderr: '{path}: No such file or directory\n',
      },
    }),
    c('ffprobe fails without stderr', {
      main: { fail: { code: 1, killed: true } },
    }),
    c('ffprobe missing', { main: { fail: { enoent: true } } }),
    // Frame rate.
    c('fps agrees with header', {
      ...base,
      main: main([video(), audio()], { duration: '3600.000000' }),
      fps: packets(1400, 1001 / 24000, 20),
    }),
    c('fps header lies', {
      ...base,
      main: main(
        [video({ r_frame_rate: '500/21', avg_frame_rate: '500/21' }), audio()],
        { duration: '3600.000000' },
      ),
      fps: packets(1400, 1001 / 24000, 20),
    }),
    c('fps header lies two video streams', {
      ...base,
      main: main(
        [
          video({ r_frame_rate: '500/21' }),
          video({ index: 1, r_frame_rate: '500/21' }),
          audio({ index: 2 }),
        ],
        { duration: '3600.000000' },
      ),
      fps: packets(1400, 1001 / 24000, 20),
    }),
    c('fps short file not measured', {
      ...base,
      main: main([video({ r_frame_rate: '500/21' }), audio()], {
        duration: '89.9',
      }),
    }),
    c('fps too few frames', {
      ...base,
      main: main([video({ r_frame_rate: '500/21' }), audio()], {
        duration: '3600.000000',
      }),
      fps: packets(99, 1001 / 24000),
    }),
    c('fps span zero', {
      ...base,
      main: main([video({ r_frame_rate: '500/21' }), audio()], {
        duration: '3600.000000',
      }),
      fps: packets(200, 0),
    }),
    c('fps implausible', {
      ...base,
      main: main([video({ r_frame_rate: '25/1' }), audio()], {
        duration: '3600.000000',
      }),
      fps: packets(2000, 0.001),
    }),
    c('fps unsorted packets and noise', {
      ...base,
      main: main([video({ r_frame_rate: '25/1' }), audio()], {
        duration: '3600.000000',
      }),
      fps:
        packets(150, 0.0416667).split('\n').reverse().join('\n') + 'N/A\n,\n',
    }),
    c('fps off by 0.05 percent keeps the header', {
      ...base,
      main: main(
        [video({ r_frame_rate: '24/1', avg_frame_rate: '24/1' }), audio()],
        { duration: '3600.000000' },
      ),
      fps: packets(1400, 1 / 24.012),
    }),
    c('fps off by 0.2 percent uses the packets', {
      ...base,
      main: main(
        [video({ r_frame_rate: '24/1', avg_frame_rate: '24/1' }), audio()],
        { duration: '3600.000000' },
      ),
      fps: packets(1400, 1 / 24.048),
    }),
    c('fps measurement fails', {
      ...base,
      main: main([video({ r_frame_rate: '500/21' }), audio()], {
        duration: '3600.000000',
      }),
      fps: { fail: { code: 1 } },
    }),
    c('fps long file window', {
      ...base,
      main: main([video(), audio()], { duration: '7200.5' }),
      fps: packets(1500, 0.04, 3570),
    }),
    c('fps declared forms', {
      ...base,
      main: main([
        video({ index: 0, r_frame_rate: '0/0', avg_frame_rate: '25/1' }),
        video({ index: 1, r_frame_rate: '0/1', avg_frame_rate: '30/1' }),
        video({ index: 2, r_frame_rate: '25', avg_frame_rate: '0/0' }),
        video({ index: 3, r_frame_rate: '30000/1001', avg_frame_rate: '1/0' }),
        video({ index: 4, r_frame_rate: undefined, avg_frame_rate: '60/1' }),
        video({ index: 5, r_frame_rate: '0/0', avg_frame_rate: '0/0' }),
        video({ index: 6, r_frame_rate: 'x/y', avg_frame_rate: '15/2' }),
        video({ index: 7, r_frame_rate: '1/3' }),
        video({ index: 8, r_frame_rate: '16/1', avg_frame_rate: '8/1' }),
        video({ index: 9, r_frame_rate: '-25/1', avg_frame_rate: '25/1' }),
        video({ index: 10, r_frame_rate: '25/-1', avg_frame_rate: '-5/1' }),
      ]),
    }),
    // Audio: roles, languages, tags, ends and late tracks.
    c('audio roles and languages', {
      ...base,
      main: main([
        video(),
        audio({ index: 1, tags: { language: 'ENG', title: 'Main' } }),
        audio({
          index: 2,
          disposition: { comment: 1 },
          tags: { LANGUAGE: 'fre', TITLE: 'Commentary' },
        }),
        audio({
          index: 3,
          disposition: { visual_impaired: 1 },
          tags: { language: 'und', title: 'French AC3 5.1' },
        }),
        audio({
          index: 4,
          disposition: { descriptions: 1 },
          tags: { Language: 'und' },
        }),
        audio({ index: 5, tags: { title: 'Deutsch' } }),
        audio({ index: 6, tags: {} }),
        audio({ index: 7, tags: { language: '', title: 'Español' } }),
        audio({ index: 8, tags: { language: 'eng', LANGUAGE: 'fre' } }),
        audio({
          index: 9,
          channels: 8,
          channel_layout: '7.1',
          profile: 'Dolby Digital Plus + Dolby Atmos',
          codec_name: undefined,
        }),
      ]),
    }),
    c('stream end seconds', {
      ...base,
      main: main([
        video({ tags: { DURATION: '00:01:02.500000000' } }),
        audio({ index: 1, tags: { duration: '1:02:03' } }),
        audio({ index: 2, duration: '12.5', start_time: '2.5' }),
        audio({ index: 3, tags: { DURATION: '00:00:3.0' }, duration: '4' }),
        audio({ index: 4, duration: 'N/A' }),
        audio({ index: 5, duration: '3', start_time: 'N/A' }),
        audio({ index: 6, duration: '0', start_time: '1' }),
        audio({ index: 7, duration: '', tags: { DURATION: '00:00:03' } }),
      ]),
    }),
    c('late audio track and parameters', {
      frames: [frame()],
      main: main(
        [
          video(),
          audio({ index: 1 }),
          audio({
            index: 2,
            channels: undefined,
            channel_layout: undefined,
            sample_rate: undefined,
            start_time: '0.000000',
          }),
        ],
        { start_time: '1.5' },
      ),
      audio: lines('0,1.500000', '1,1.500000', '0,1.541000', '2,9.250000'),
      late: {
        streams: [
          {
            index: 2,
            channels: 6,
            channel_layout: '5.1',
            sample_rate: '44100',
          },
        ],
      },
    }),
    c('audio first packet before header start', {
      frames: [frame()],
      main: main([video(), audio({ start_time: '2.0' })]),
      audio: lines('0,0.0', '1,1.0'),
    }),
    c('audio never shows within the window', {
      frames: [frame()],
      main: main([video(), audio()]),
      audio: lines('0,0.0', '0,130.0', '1,200.0'),
    }),
    c('audio parameters stay unknown', {
      frames: [frame()],
      main: main([
        video(),
        audio({ channels: 0, sample_rate: '0' }),
        audio({ index: 2, channels: undefined }),
      ]),
      audio: AUDIO_PACKETS,
      late: {
        streams: [
          { index: 1, channels: 0 },
          { index: 2, sample_rate: '-1', channel_layout: 'mono' },
        ],
      },
    }),
    c('late audio probe fails', {
      frames: [frame()],
      main: main([video(), audio({ channels: undefined })]),
      audio: AUDIO_PACKETS,
      late: { fail: { code: 1 } },
    }),
    c('late audio probe unparsable', {
      frames: [frame()],
      main: main([video(), audio({ channels: undefined })]),
      audio: AUDIO_PACKETS,
      late: 'nope',
    }),
    c('audio packet probe fails', {
      frames: [frame()],
      main: main([video(), audio()]),
      audio: { fail: { code: 1 } },
    }),
    c('audio packets with noise', {
      frames: [frame()],
      main: main([video(), audio({ start_time: '0.1' })]),
      audio: lines('garbage', '0,N/A', '', '0,0.5', 'x,0.2', '1,0.4'),
    }),
    // Subtitles and chapters.
    c('subtitle flags and codecs', {
      ...base,
      main: main([
        video(),
        audio(),
        sub({ index: 2, codec_name: 'hdmv_pgs_subtitle' }),
        sub({
          index: 3,
          codec_name: 'dvd_subtitle',
          tags: { language: 'fre', title: 'Forced' },
        }),
        sub({ index: 4, codec_name: 'dvb_subtitle' }),
        sub({ index: 5, codec_name: 'xsub' }),
        sub({ index: 6, codec_name: 'ass', tags: { title: 'English SDH' } }),
        sub({
          index: 7,
          codec_name: 'mov_text',
          tags: { title: 'non-forced' },
        }),
        sub({ index: 8, codec_name: undefined, disposition: { forced: 1 } }),
        sub({
          index: 9,
          disposition: { hearing_impaired: 1, forced: 1 },
          tags: { title: 'Closed Captions' },
        }),
        sub({ index: 10, tags: { TITLE: 'not forced', LANGUAGE: 'spa' } }),
        sub({ index: 11, tags: { title: 'Foreign Parts' } }),
        sub({ index: 12, tags: { title: 'Français' } }),
        sub({ index: 13, tags: undefined, disposition: undefined }),
      ]),
    }),
    c('chapters', {
      ...base,
      main: main([video(), audio()], {}, [
        { start_time: '0.000000', end_time: '10.5', tags: { title: 'Intro' } },
        { start_time: '10.5', end_time: '10.5', tags: { title: 'Empty' } },
        { end_time: '20', tags: { TITLE: 'No start' } },
        { start_time: '30' },
        { start_time: '40', end_time: 'N/A' },
        { start_time: '60', end_time: '50' },
        { start_time: '50', end_time: '60', tags: {} },
        { start_time: 'N/A', end_time: '5' },
      ]),
    }),
    // Containers and numbers.
    c('numbers and missing fields', {
      ...base,
      main: main(
        [
          video({
            level: -99,
            profile: undefined,
            bit_rate: 'N/A',
            bits_per_raw_sample: '',
            has_b_frames: 0,
            display_aspect_ratio: '0:1',
            start_time: 'N/A',
          }),
          audio({ bit_rate: '0', start_time: '', sample_rate: 'abc' }),
        ],
        { bit_rate: '0', duration: undefined, format_name: undefined },
      ),
    }),
    c('format bit rate and duration', {
      ...base,
      main: main([video(), audio()], {
        bit_rate: '12345678',
        duration: '5400.123',
        start_time: '-0.5',
        format_name: 'mpegts',
      }),
    }),
    // Matroska language tags.
    c('mkvmerge tags', {
      ...base,
      main: main([
        video(),
        audio({ index: 1 }),
        audio({ index: 2 }),
        sub({ index: 3 }),
        sub({ index: 4 }),
        sub({ index: 5 }),
      ]),
      mkv: mkv(
        [0, 'video', 'es-419'],
        [1, 'audio', 'es-419'],
        [2, 'audio', 'en'],
        [3, 'subtitles', 'pt-BR'],
        [4, 'audio', 'zh-Hant'],
        [5, 'subtitles', 'und-Latn'],
      ),
    }),
    c('mkvmerge exits 1 with output', {
      ...base,
      main: main([video(), audio()]),
      mkv: {
        fail: { code: 1 },
        stdout: mkv([1, 'audio', 'fr-CA']),
        stderr: 'warning',
      },
    }),
    c('mkvmerge exits 1 without tags', {
      ...base,
      main: main([video(), audio()]),
      mkv: { fail: { code: 2 }, stdout: mkv([1, 'audio', 'fr']) },
    }),
    c('mkvmerge missing', {
      ...base,
      main: main([video(), audio()]),
      mkv: { fail: { enoent: true } },
    }),
    c('mkvmerge unparsable', {
      ...base,
      main: main([video(), audio()]),
      mkv: 'not json',
    }),
    c('mkvmerge odd tracks', {
      ...base,
      main: main([video(), audio({ index: 1 }), audio({ index: 2 })]),
      mkv: JSON.stringify({
        tracks: [
          null,
          { id: '1', type: 'audio', properties: { language_ietf: 'fr-CA' } },
          { id: 1, type: 'audio', properties: { language_ietf: 'fr-CA-x' } },
          { id: 2, type: 'audio' },
          { id: 1, type: 'audio', properties: { language_ietf: 'de-DE-1996' } },
        ],
      }),
    }),
    c('mkvmerge tag syntax', {
      ...base,
      main: main([
        video(),
        audio({ index: 1 }),
        audio({ index: 2 }),
        audio({ index: 3 }),
        audio({ index: 4 }),
        audio({ index: 5 }),
      ]),
      mkv: mkv(
        [1, 'audio', 'ES-419'],
        [2, 'audio', 'e-US'],
        [3, 'audio', 'es-4'],
        [4, 'audio', 'eng-123456789'],
        [5, 'audio', 'UND-419'],
      ),
    }),
    c('not matroska', {
      ...base,
      main: main([video(), audio()], {
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      }),
      mkv: mkv([1, 'audio', 'fr-CA']),
    }),
    c('webm counts as matroska', {
      ...base,
      main: main([video(), audio()], { format_name: 'matroska,webm' }),
      mkv: mkv([1, 'audio', 'fr-CA']),
    }),
    // First frame timestamps.
    c('first frame pts only', {
      audio: AUDIO_PACKETS,
      main: main([video({ time_base: '1/90000' }), audio()]),
      frames: [frame([], { pts: 126000, best_effort_timestamp: undefined })],
    }),
    c('first frame best effort', {
      audio: AUDIO_PACKETS,
      main: main([video({ time_base: '1/24' }), audio()]),
      frames: [frame([], { pts: undefined, best_effort_timestamp: 48 })],
    }),
    c('first frame bad time base', {
      audio: AUDIO_PACKETS,
      main: main([video({ time_base: '0/1' }), audio()]),
      frames: [frame([], { pts: 5 })],
    }),
    c('first frame no timestamps', {
      audio: AUDIO_PACKETS,
      main: main([video(), audio()]),
      frames: [{ side_data_list: [] }],
    }),
    c('first frame negative', {
      audio: AUDIO_PACKETS,
      main: main([video({ time_base: '1/1000' }), audio()]),
      frames: [frame([], { pts: -83 })],
    }),
    c('first frame fraction time base', {
      audio: AUDIO_PACKETS,
      main: main([video({ time_base: '1001/24000' }), audio()]),
      frames: [frame([], { pts: 3 })],
    }),
    // Crop.
    c('crop letterbox', {
      ...base,
      main: main([video({ width: 480, height: 270 }), audio()]),
      crop: {
        3: crop(480, 190, 0, 40),
        9: crop(480, 190, 0, 40),
        18: crop(480, 192, 0, 39),
        27: crop(480, 190, 0, 40),
        36: crop(480, 190, 0, 40),
        48: crop(480, 190, 0, 40),
      },
    }),
    c('crop loosest box wins', {
      ...base,
      main: main([video({ width: 1920, height: 1080 }), audio()]),
      crop: {
        3: crop(1920, 800, 0, 140),
        9: crop(1920, 816, 0, 132),
        18: crop(1920, 816, 0, 132),
        27: crop(1920, 1080, 0, 0),
        36: crop(1920, 700, 0, 190),
        48: crop(1920, 816, 0, 132),
      },
    }),
    c('crop small bars ignored', {
      ...base,
      main: main([video({ width: 480, height: 270 }), audio()]),
      crop: sameCrop(480, 254, 0, 8),
    }),
    c('crop exactly forty pixels', {
      ...base,
      main: main([video({ width: 480, height: 270 }), audio()]),
      crop: sameCrop(480, 230, 0, 20),
    }),
    c('crop pillarbox', {
      ...base,
      main: main([video({ width: 480, height: 270 }), audio()]),
      crop: sameCrop(320, 270, 80, 0),
    }),
    c('crop first sample retried', {
      ...base,
      main: main([video({ width: 480, height: 270 }), audio()]),
      crop: {
        3: { fail: { code: 1 } },
        9: crop(480, 190, 0, 40),
        18: crop(480, 190, 0, 40),
        27: crop(480, 190, 0, 40),
        36: crop(480, 190, 0, 40),
        48: crop(480, 190, 0, 40),
      },
    }),
    c('crop first sample refused twice', {
      ...base,
      main: main([video({ width: 480, height: 270 }), audio()]),
      crop: { 3: { fail: { code: 1 } }, 9: crop(480, 190, 0, 40) },
    }),
    c('crop every sample fails', {
      ...base,
      main: main([video({ width: 480, height: 270 }), audio()]),
      crop: { fail: { code: 1 } },
    }),
    c('crop no log line', {
      ...base,
      main: main([video({ width: 480, height: 270 }), audio()]),
      crop: 'frame=1\n',
    }),
    c('crop unknown duration', {
      ...base,
      main: main([video({ width: 480, height: 270 }), audio()], {
        duration: undefined,
      }),
      crop: sameCrop(480, 190, 0, 40),
    }),
    c('crop rotated video', {
      ...base,
      main: main([
        video({
          width: 1920,
          height: 1080,
          side_data_list: [{ rotation: -90 }],
        }),
        audio(),
      ]),
      crop: sameCrop(1080, 1280, 0, 320),
    }),
    c('crop without video size', {
      ...base,
      main: main([video({ width: undefined, height: undefined }), audio()]),
      crop: sameCrop(480, 190, 0, 40),
    }),
    c('crop zero size treated as unknown', {
      ...base,
      main: main([video({ width: 0, height: 0 }), audio()]),
      crop: sameCrop(480, 190, 0, 40),
    }),
    c(
      'crop disabled',
      { ...base, main: main([video({ width: 480, height: 270 }), audio()]) },
      5000,
      { crop: false, mkvTags: true },
    ),
    c('crop skipped without video', {
      audio: AUDIO_PACKETS,
      main: main([audio({ index: 0 })]),
    }),
    c('crop with long file', {
      ...base,
      main: main([video({ width: 3840, height: 2160 }), audio()], {
        duration: '7261.4',
      }),
      crop: {
        363: crop(3840, 1600, 0, 280),
        1089: crop(3840, 1600, 0, 280),
        2178: crop(3840, 1608, 0, 276),
        3267: crop(3840, 1600, 0, 280),
        4356: crop(3840, 1600, 0, 280),
        5809: crop(3840, 1600, 0, 280),
      },
    }),
  ];
}
