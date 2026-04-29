import { Logger } from '@nestjs/common';
import * as path from 'path';
import { getInitTime, getSegmentDuration } from './constants';
import { parseBitrateToBps } from './profiles';
import type {
  BurnInSubtitle,
  HwAccelType,
  TranscodeProfile,
} from './types';

export interface BuildFfmpegArgsOptions {
  inputPath: string;
  profile: TranscodeProfile;
  outputDir: string;
  hwAccel: HwAccelType;
  startSegment?: number;
  tonemap?: boolean;
  burnIn?: BurnInSubtitle;
  audioStreamIndex?: number;
  crop?: { width: number; height: number; x: number; y: number };
  videoOnly?: boolean;
  mapAllAudio?: boolean;
  audioStreams?: { language?: string; title?: string }[];
  useFmp4?: boolean;
  encoderPreset?: string;
  qsvOptions?: { lookahead: boolean; lowPower: boolean; adaptive: boolean };
  sourceFps?: number;
  trustedStreamInfo?: boolean;
}

export function buildFfmpegArgs(
  opts: BuildFfmpegArgsOptions,
  log: Logger,
): string[] {
  const {
    inputPath,
    profile,
    outputDir,
    hwAccel,
    startSegment = 0,
    tonemap = false,
    burnIn,
    audioStreamIndex,
    crop,
    videoOnly = false,
    mapAllAudio = false,
    audioStreams,
    useFmp4 = true,
    encoderPreset = 'faster',
    qsvOptions = { lookahead: false, lowPower: false, adaptive: true },
    sourceFps,
    trustedStreamInfo = false,
  } = opts;

  const SEGMENT_DURATION = getSegmentDuration();
  const INIT_TIME = getInitTime();

  // GOP = segment_duration × fps so each segment starts exactly on an IDR.
  // Fallback to 24 fps when source fps is unknown (safe for most content).
  const fps = sourceFps && sourceFps > 0 ? sourceFps : 24;
  const gopSize = Math.max(1, Math.round(SEGMENT_DURATION * fps));
  // Keyframes at: 0, INIT_TIME, INIT_TIME+SEG, INIT_TIME+2*SEG, ...
  // Lets -hls_init_time actually cut segment 0 short (needs a keyframe at
  // INIT_TIME). When INIT_TIME >= SEGMENT_DURATION, collapses to regular
  // fixed-GOP behaviour.
  const forceKeyframesExpr = `expr:if(eq(n_forced,0),gte(t,0),gte(t,${INIT_TIME}+(n_forced-1)*${SEGMENT_DURATION}))`;
  // Build reusable QSV extra options flag list.
  const qsvExtra: string[] = [];
  if (qsvOptions.lookahead) {
    qsvExtra.push('-look_ahead', '1', '-look_ahead_depth', '40');
  }
  if (qsvOptions.lowPower) {
    qsvExtra.push('-low_power', '1');
  }
  if (qsvOptions.adaptive) {
    qsvExtra.push('-adaptive_i', '1', '-adaptive_b', '1');
  }
  const args = ['-hide_banner', '-loglevel', 'warning'];

  // Reduce FFmpeg's avformat_find_stream_info scan. When we already have a
  // trusted streamInfo in the DB (populated by ffprobe at import/rescan),
  // collapse the probe to effectively nothing — FFmpeg just reads container
  // headers and stops. Otherwise fall back to a balanced 1s/1MB budget.
  // Default FFmpeg is 5s/5MB which burns 3-5s on cold start of large 4K MKVs.
  if (trustedStreamInfo) {
    log.log('Probe: using cached streamInfo (0s / 200KB scan)');
    args.push('-analyzeduration', '0', '-probesize', '200000');
  } else {
    log.log('Probe: no cached streamInfo — running full FFmpeg scan (1s / 1MB)');
    args.push('-analyzeduration', '1000000', '-probesize', '1000000');
  }

  // Seek to start position if needed
  if (startSegment > 0) {
    const seekSeconds = startSegment * SEGMENT_DURATION;
    args.push('-ss', String(seekSeconds));
    // -copyts preserves original timestamps so HLS segment timestamps match
    // the source file timeline (required for subtitle sync)
    args.push('-copyts', '-avoid_negative_ts', 'make_zero');
  }

  // parseBitrateToBps handles both "8M" and "200k" correctly. Using parseInt()*1e6
  // would give 200 Mbps for "200k" (it drops the suffix and multiplies as if M).
  const bitrateNum = parseBitrateToBps(profile.videoBitrate);

  // Force pipeline adjustments when HW accel can't handle required filters:
  // - Subtitle burn-in is always CPU-only
  // - QSV can't crop (fixed-size pool constraint), fallback to VAAPI encode which supports hwdownload/hwupload
  const effectiveHwAccel: HwAccelType = burnIn?.filter
    ? 'none'
    : hwAccel === 'qsv' && crop
      ? 'vaapi'
      : hwAccel;

  // Hardware acceleration input decoding
  if (effectiveHwAccel === 'qsv') {
    // Jellyfin approach on Linux: decode with VAAPI (native), scale with VAAPI,
    // then map to QSV surfaces for encoding. More compatible than pure QSV pipeline.
    args.push(
      '-init_hw_device', 'vaapi=va:/dev/dri/renderD128',
      '-init_hw_device', 'qsv=qs@va',
    );
    if (tonemap) {
      args.push('-init_hw_device', 'opencl=ocl:0.0', '-filter_hw_device', 'ocl');
    }
    args.push(
      '-hwaccel', 'vaapi',
      '-hwaccel_output_format', 'vaapi',
      '-hwaccel_device', 'va',
      '-extra_hw_frames', '32',
      '-noautorotate',
    );
  } else if (effectiveHwAccel === 'vaapi') {
    args.push('-init_hw_device', 'vaapi=va:/dev/dri/renderD128');
    if (tonemap) {
      args.push('-init_hw_device', 'opencl=ocl:0.0', '-filter_hw_device', 'ocl');
    }
    args.push(
      '-hwaccel', 'vaapi',
      '-hwaccel_output_format', 'vaapi',
      '-hwaccel_device', 'va',
      '-extra_hw_frames', '32',
      '-noautorotate',
    );
  } else if (effectiveHwAccel === 'nvenc') {
    if (tonemap) {
      // For tone mapping, don't force cuda output format — allows hwdownload to CPU
      args.push('-hwaccel', 'cuda', '-noautorotate');
    } else {
      args.push(
        '-hwaccel', 'cuda',
        '-hwaccel_output_format', 'cuda',
        '-noautorotate',
      );
    }
  }

  args.push('-i', inputPath);

  // Video encoding
  const w = profile.maxWidth;
  const cropStr = crop
    ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`
    : '';
  const cpuCropPrefix = cropStr ? `${cropStr},` : '';
  const burnInFilter = burnIn?.filter ? `,${burnIn.filter}` : '';
  const tonemapOpencl =
    tonemap && !burnIn?.filter
      ? ',hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0'
      : '';
  const tonemapCpu = tonemap
    ? `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,`
    : '';

  // For HW paths with crop: hwdownload to CPU, crop, then hwupload back.
  const hwCropPrefix = cropStr
    ? `hwdownload,format=nv12,${cropStr},hwupload=derive_device=vaapi,`
    : '';

  switch (effectiveHwAccel) {
    case 'qsv':
      // Note: QSV + crop is forced to CPU via effectiveHwAccel (fixed-size pool constraint)
      if (tonemapOpencl) {
        // VAAPI decode → VAAPI scale → OpenCL tonemap → map to QSV → QSV encode
        args.push(
          '-c:v', 'h264_qsv',
          '-preset', encoderPreset,
          ...qsvExtra,
          '-mbbrc', '1',
          '-b:v', String(bitrateNum),
          '-maxrate', String(bitrateNum + 1),
          '-rc_init_occupancy', String(bitrateNum * 2),
          '-bufsize', String(bitrateNum * 4),
          '-vf',
          `scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${tonemapOpencl},hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv`,
          '-g', String(gopSize),
          '-keyint_min', String(gopSize),
          '-force_key_frames', forceKeyframesExpr,
        );
      } else {
        args.push(
          '-c:v', 'h264_qsv',
          '-preset', encoderPreset,
          ...qsvExtra,
          '-mbbrc', '1',
          '-b:v', String(bitrateNum),
          '-maxrate', String(bitrateNum + 1),
          '-rc_init_occupancy', String(bitrateNum * 2),
          '-bufsize', String(bitrateNum * 4),
          '-vf',
          `scale_vaapi=w=${w}:h=-16:format=nv12:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv`,
          '-g', String(gopSize),
          '-keyint_min', String(gopSize),
          '-force_key_frames', forceKeyframesExpr,
        );
      }
      break;
    case 'vaapi':
      if (tonemapOpencl) {
        args.push(
          '-c:v', 'h264_vaapi',
          '-b:v', profile.videoBitrate,
          '-maxrate', profile.videoBitrate,
          '-vf',
          `${hwCropPrefix}scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${tonemapOpencl},hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi`,
          '-g', String(gopSize),
          '-keyint_min', String(gopSize),
          '-force_key_frames', forceKeyframesExpr,
        );
      } else {
        args.push(
          '-c:v', 'h264_vaapi',
          '-b:v', profile.videoBitrate,
          '-maxrate', profile.videoBitrate,
          '-vf',
          `${hwCropPrefix}scale_vaapi=w=${w}:h=-16:format=nv12`,
          '-g', String(gopSize),
          '-keyint_min', String(gopSize),
          '-force_key_frames', forceKeyframesExpr,
        );
      }
      break;
    case 'nvenc':
      if (tonemap) {
        // No native GPU tone mapping — download from GPU, tonemap on CPU, encode with NVENC
        args.push(
          '-c:v', 'h264_nvenc',
          '-preset', 'p4',
          '-b:v', profile.videoBitrate,
          '-maxrate', profile.videoBitrate,
          '-vf',
          `hwdownload,format=p010le,${cpuCropPrefix}${tonemapCpu}scale=${w}:-2`,
          '-g', String(gopSize),
          '-keyint_min', String(gopSize),
          '-force_key_frames', forceKeyframesExpr,
        );
      } else {
        const nvCropFilter = cropStr
          ? `hwdownload,format=nv12,${cropStr},hwupload_cuda,`
          : '';
        args.push(
          '-c:v', 'h264_nvenc',
          '-preset', 'p4',
          '-b:v', profile.videoBitrate,
          '-maxrate', profile.videoBitrate,
          '-vf',
          `${nvCropFilter}scale_cuda=w=${w}:h=-2:format=nv12`,
          '-g', String(gopSize),
          '-keyint_min', String(gopSize),
          '-force_key_frames', forceKeyframesExpr,
        );
      }
      break;
    default:
      args.push(
        '-c:v', 'libx264',
        // Cap frame-threading so segment 0 emits before a long (threads-1)-frame prebuffer.
        '-threads:v', '4',
        '-preset', encoderPreset,
        '-b:v', profile.videoBitrate,
        '-maxrate', profile.videoBitrate,
        '-bufsize', `${parseInt(profile.videoBitrate) * 2}M`,
        '-vf',
        `${cpuCropPrefix}${tonemapCpu}scale=${w}:-2:flags=lanczos,format=yuv420p${burnInFilter}`,
        '-force_key_frames', forceKeyframesExpr,
        '-sc_threshold:v:0', '0',
      );
      break;
  }

  // ── Audio mapping + HLS output ──
  // Always use var_stream_map for fMP4 multi-audio, even when the user has
  // picked a specific track — otherwise switching audio would require a
  // full backend reload. With all audio renditions exposed, Shaka switches
  // client-side via EXT-X-MEDIA. The picked track is signalled via
  // DEFAULT=YES in the master.m3u8 (see streaming.controller.ts).
  const userPickedAudio = audioStreamIndex != null && audioStreamIndex > 0;
  const useVarStreamMap =
    useFmp4 && videoOnly && audioStreams && audioStreams.length > 1;

  if (useVarStreamMap) {
    // Single FFmpeg process for video + all audio renditions (perfect sync).
    if (!args.some((a) => a === '-map')) {
      args.push('-map', '0:v:0');
    }
    for (let i = 0; i < audioStreams.length; i++) {
      args.push('-map', `0:a:${i}`);
    }
    args.push('-c:a', 'aac', '-b:a', profile.audioBitrate, '-ac', '2');

    // Build var_stream_map: "v:0,agroup:audio a:0,agroup:audio,language:fre ..."
    const varParts = ['v:0,agroup:audio'];
    for (let i = 0; i < audioStreams.length; i++) {
      const lang = audioStreams[i].language || 'und';
      varParts.push(`a:${i},agroup:audio,language:${lang}`);
    }

    args.push(
      '-f', 'hls',
      '-hls_time', String(SEGMENT_DURATION),
      '-hls_init_time', String(INIT_TIME),
      '-hls_list_size', '0',
      '-start_number', String(startSegment),
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init_%v.mp4',
      '-hls_flags', 'independent_segments',
      '-var_stream_map', varParts.join(' '),
      '-hls_segment_filename', path.join(outputDir, '%v', 'seg-%04d.m4s'),
      path.join(outputDir, '%v', 'index.m3u8'),
    );
  } else {
    // Standard single-stream output.
    // `userPickedAudio` (audioStreamIndex set) wins over `mapAllAudio`:
    // when the user explicitly chose a track from the UI, honour it with a
    // single -map so the next reload actually plays that audio. Otherwise
    // mapAllAudio mux every PID for native client-side switching.
    if (userPickedAudio) {
      args.push('-map', '0:v:0', '-map', `0:a:${audioStreamIndex}`);
    } else if (mapAllAudio && audioStreams && audioStreams.length > 1) {
      // TS + multi-audio: mux ALL audio tracks so native players (ExoPlayer/AVPlayer) can switch
      args.push('-map', '0:v:0');
      for (let i = 0; i < audioStreams.length; i++) {
        args.push('-map', `0:a:${i}`);
        const lang = audioStreams[i].language;
        if (lang) {
          args.push(`-metadata:s:a:${i}`, `language=${lang}`);
        }
      }
    } else {
      // Default: explicitly map only video + first audio. Skips ffmpeg's
      // auto-pick of a subtitle stream — mandatory on sources with many
      // subtitle tracks (some HEVC MKVs have 28+) where the parallel
      // subrip→webvtt pipeline starves the VAAPI HEVC decoder buffer
      // pool, making the early session loop on "thread_get_buffer() failed".
      args.push('-map', '0:v:0', '-map', '0:a:0');
    }
    args.push('-c:a', 'aac', '-b:a', profile.audioBitrate, '-ac', '2');

    args.push(
      '-f', 'hls',
      '-hls_time', String(SEGMENT_DURATION),
      '-hls_init_time', String(INIT_TIME),
      '-hls_list_size', '0',
      '-start_number', String(startSegment),
    );
    if (useFmp4) {
      args.push(
        '-hls_segment_type', 'fmp4',
        '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', path.join(outputDir, 'seg-%04d.m4s'),
      );
    } else {
      args.push('-hls_segment_filename', path.join(outputDir, 'seg-%04d.ts'));
    }
    args.push(
      '-hls_flags', 'independent_segments',
      path.join(outputDir, 'index.m3u8'),
    );
  }

  return args;
}

/**
 * Build FFmpeg args for audio-only HLS output (used for multi-audio EXT-X-MEDIA renditions).
 * Lightweight: no video encoding, no HW accel needed.
 */
export function buildAudioOnlyFfmpegArgs(
  inputPath: string,
  outputDir: string,
  audioStreamIndex: number,
  audioBitrate = '192k',
  startSegment = 0,
  trustedStreamInfo = false,
  log: Logger,
): string[] {
  const SEGMENT_DURATION = getSegmentDuration();
  const INIT_TIME = getInitTime();

  const args = ['-hide_banner', '-loglevel', 'warning'];
  if (trustedStreamInfo) {
    log.log('Probe [audio-only]: using cached streamInfo (0s / 200KB scan)');
    args.push('-analyzeduration', '0', '-probesize', '200000');
  } else {
    log.log(
      'Probe [audio-only]: no cached streamInfo — running full FFmpeg scan (1s / 1MB)',
    );
    args.push('-analyzeduration', '1000000', '-probesize', '1000000');
  }

  if (startSegment > 0) {
    args.push('-ss', String(startSegment * SEGMENT_DURATION));
    args.push('-copyts', '-avoid_negative_ts', 'make_zero');
  }

  args.push('-i', inputPath);
  args.push('-map', `0:a:${audioStreamIndex}`);
  args.push('-vn');
  args.push('-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2');

  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_DURATION),
    '-hls_init_time', String(INIT_TIME),
    '-hls_list_size', '0',
    '-start_number', String(startSegment),
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(outputDir, 'seg-%04d.m4s'),
    '-hls_flags', 'independent_segments',
    path.join(outputDir, 'index.m3u8'),
  );

  return args;
}

/**
 * Build FFmpeg args for remux mode: copy video stream, optionally transcode audio.
 * This is much cheaper than full transcoding — no video re-encoding.
 */
export function buildRemuxArgs(
  inputPath: string,
  outputDir: string,
  copyAudio: boolean,
  audioBitrate = '192k',
  startSegment = 0,
  videoOnly = false,
  mapAllAudio = false,
  audioStreams?: { language?: string; title?: string }[],
  useFmp4 = true,
  trustedStreamInfo = false,
  audioStreamIndex?: number,
  log?: Logger,
): string[] {
  const SEGMENT_DURATION = getSegmentDuration();
  const INIT_TIME = getInitTime();

  const args = ['-hide_banner', '-loglevel', 'warning'];
  if (trustedStreamInfo) {
    log?.log('Probe [remux]: using cached streamInfo (0s / 200KB scan)');
    args.push('-analyzeduration', '0', '-probesize', '200000');
  } else {
    log?.log('Probe [remux]: no cached streamInfo — running full FFmpeg scan (1s / 1MB)');
    args.push('-analyzeduration', '1000000', '-probesize', '1000000');
  }

  if (startSegment > 0) {
    args.push('-ss', String(startSegment * SEGMENT_DURATION));
    args.push('-copyts', '-avoid_negative_ts', 'make_zero');
  }

  args.push('-i', inputPath);

  const userPickedAudio = audioStreamIndex != null && audioStreamIndex > 0;
  if (videoOnly && !userPickedAudio) {
    // Video-only remux for fMP4 var_stream_map (audio served separately).
    args.push('-map', '0:v:0', '-c:v', 'copy', '-an');
  } else if (userPickedAudio) {
    args.push('-map', '0:v:0', '-map', `0:a:${audioStreamIndex}`, '-c:v', 'copy');
    if (copyAudio) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2');
    }
  } else if (mapAllAudio && audioStreams && audioStreams.length > 1) {
    args.push('-map', '0:v:0', '-c:v', 'copy');
    for (let i = 0; i < audioStreams.length; i++) {
      args.push('-map', `0:a:${i}`);
      const lang = audioStreams[i].language;
      if (lang) args.push(`-metadata:s:a:${i}`, `language=${lang}`);
    }
    if (copyAudio) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2');
    }
  } else {
    args.push('-c:v', 'copy');
    if (copyAudio) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2');
    }
  }

  // HLS output — fMP4 or TS based on useFmp4
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_DURATION),
    '-hls_init_time', String(INIT_TIME),
    '-hls_list_size', '0',
    '-start_number', String(startSegment),
  );
  if (useFmp4) {
    args.push(
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(outputDir, 'seg-%04d.m4s'),
    );
  } else {
    args.push('-hls_segment_filename', path.join(outputDir, 'seg-%04d.ts'));
  }
  args.push(
    '-hls_flags', 'independent_segments',
    path.join(outputDir, 'index.m3u8'),
  );

  return args;
}
