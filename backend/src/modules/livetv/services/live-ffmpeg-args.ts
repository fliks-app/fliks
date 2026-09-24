import type { HwAccelType } from '../../streaming/transcoding/types';
import { liveTvFfmpegHeaderArgs } from '../livetv-http';

export type LiveEncodeMode = 'remux' | 'transcode';

export interface LiveFfmpegArgsOptions {
  inputUrl: string;
  outputDir: string;
  segmentSeconds: number;
  windowMinutes: number;
  mode: LiveEncodeMode;
  /** MPEG-TS segments instead of fMP4 (Tizen AVPlay fallback). */
  useTs: boolean;
  userAgent?: string | null;
  referer?: string | null;
  hwAccel: HwAccelType;
  videoBitrateBps?: number;
  /** Probed source audio codec. `aac` is passed through untouched. */
  audioCodec?: string | null;
  /** Continue an existing playlist after a failover respawn into the same directory. */
  append?: boolean;
  /** Admin-tunable `livetv_probe_seconds` (default 3). Widens the probe for a
   *  long-GOP feed; never narrows below the 3 s / 5 MB floor (measured: a
   *  smaller window intermittently fails "Could not find codec parameters"
   *  depending on where the join lands in the GOP). */
  probeSeconds?: number;
}

/** Used only when `mode: 'transcode'` and the caller didn't pin a target. */
const DEFAULT_TRANSCODE_BITRATE_BPS = 4_000_000;

const DEFAULT_PROBE_SECONDS = 3;
/** Bytes at the default probe window; scaled linearly with `probeSeconds`. */
const BASE_PROBESIZE_BYTES = 5_000_000;

const H264_ENCODER: Record<HwAccelType, string> = {
  none: 'libx264',
  qsv: 'h264_qsv',
  vaapi: 'h264_vaapi',
  nvenc: 'h264_nvenc',
  amf: 'h264_amf',
  videotoolbox: 'h264_videotoolbox',
};

/** Input-side decode flags, applied before `-i`. `amf` and `none` decode in software. */
const HWACCEL_INPUT_FLAGS: Partial<Record<HwAccelType, string[]>> = {
  qsv: ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv'],
  vaapi: ['-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi'],
  nvenc: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
  videotoolbox: ['-hwaccel', 'videotoolbox'],
};

/**
 * Live HLS output flags, kept separate from the VOD `buildFfmpegArgs`: live has
 * no known duration and no seekable segment grid, so it uses ffmpeg's own
 * sliding-window HLS muxer instead of the VOD cache/timeline machinery.
 *
 * Audio is always re-encoded to AAC, even on a remux: providers commonly ship
 * MP2/AC-3, which browsers refuse, and a video-only stream is the single most
 * reported failure of this kind of feature.
 */
export function buildLiveFfmpegArgs(opts: LiveFfmpegArgsOptions): string[] {
  const args: string[] = [
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_on_network_error',
    '1',
    '-reconnect_delay_max',
    '5',
    '-rw_timeout',
    '15000000',
  ];
  // Providers block the ffmpeg default user agent outright.
  args.push(...liveTvFfmpegHeaderArgs({ userAgent: opts.userAgent, referer: opts.referer }));
  const probeSeconds = Math.max(DEFAULT_PROBE_SECONDS, opts.probeSeconds ?? DEFAULT_PROBE_SECONDS);
  const probesize = Math.round(
    (BASE_PROBESIZE_BYTES * probeSeconds) / DEFAULT_PROBE_SECONDS,
  );
  // No `nobuffer` / `low_delay` here. Measured: they make the muxer emit the
  // audio it already has before the first video keyframe arrives, so a session
  // opens with a two second audio-only head, and they buy no zapping speed.
  args.push(
    '-analyzeduration',
    String(probeSeconds * 1_000_000),
    '-probesize',
    String(probesize),
  );

  if (opts.mode === 'transcode') {
    args.push(...(HWACCEL_INPUT_FLAGS[opts.hwAccel] ?? []));
  }

  args.push('-i', opts.inputUrl);
  args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');

  if (opts.mode === 'remux') {
    args.push('-c:v', 'copy');
  } else {
    args.push('-c:v', H264_ENCODER[opts.hwAccel]);
    if (opts.hwAccel === 'none') {
      args.push('-preset', 'veryfast', '-tune', 'zerolatency');
    }
    const bitrate = opts.videoBitrateBps ?? DEFAULT_TRANSCODE_BITRATE_BPS;
    args.push(
      '-b:v',
      String(bitrate),
      '-maxrate',
      String(bitrate),
      // 2x bitrate, matching the steady-state VOD bufsize convention.
      '-bufsize',
      String(bitrate * 2),
      // Time-based (not frame-count) so every segment starts on a keyframe
      // regardless of the source's real, possibly variable, frame rate.
      '-force_key_frames',
      `expr:gte(t,n_forced*${opts.segmentSeconds})`,
    );
  }

  if (opts.audioCodec === 'aac') {
    // Measured: re-encoding AAC puts the audio 22 ms ahead of the video, the
    // encoder's priming delay, which fragmented MP4 carries no edit list to
    // compensate. Copying reproduces the source exactly and costs nothing.
    args.push('-c:a', 'copy');
    // TS carries AAC in ADTS, MP4 wants it bare.
    if (!opts.useTs) args.push('-bsf:a', 'aac_adtstoasc');
  } else {
    // Providers ship MP2 and AC-3 that browsers refuse, and a silent stream is
    // the single most reported failure of this kind of feature.
    args.push('-c:a', 'aac', '-ac', '2', '-b:a', '128k');
  }

  // Floored at 1: a 0 here (bad segment/window settings) would tell ffmpeg to
  // keep every segment forever instead of sliding the live window.
  const listSize = Math.max(
    1,
    Math.ceil((opts.windowMinutes * 60) / opts.segmentSeconds),
  );
  const segExt = opts.useTs ? 'ts' : 'm4s';
  const hlsFlags = [
    'delete_segments',
    'omit_endlist',
    'independent_segments',
    'temp_file',
    'program_date_time',
  ];
  if (opts.append) hlsFlags.push('append_list', 'discont_start');
  // No `-start_number` on an append respawn: ffmpeg continues the existing
  // playlist's own numbering. Passing one desyncs MEDIA-SEQUENCE from the
  // real first segment on disk (measured) and a player skips on the join.

  args.push(
    '-f',
    'hls',
    '-hls_time',
    String(opts.segmentSeconds),
    '-hls_list_size',
    String(listSize),
    '-hls_delete_threshold',
    '3',
    '-hls_segment_type',
    opts.useTs ? 'mpegts' : 'fmp4',
  );
  // No init segment for MPEG-TS: each .ts segment is self-contained.
  if (!opts.useTs) args.push('-hls_fmp4_init_filename', 'init.mp4');
  args.push(
    '-hls_flags',
    hlsFlags.join('+'),
    '-hls_segment_filename',
    `${opts.outputDir}/seg-%05d.${segExt}`,
    `${opts.outputDir}/index.m3u8`,
  );

  return args;
}
