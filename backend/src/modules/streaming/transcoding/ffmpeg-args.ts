import { Logger } from '@nestjs/common';
import * as path from 'path';
import {
  getSegmentDuration,
  segmentIndexToSeconds,
} from './constants';
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
  audioStreams?: { language?: string; title?: string }[];
  /** Audio output decision — see {@link SessionContext.audioPlan}. When
   *  omitted, ffmpeg-args falls back to AAC stereo at the profile bitrate
   *  (safe default that plays everywhere). */
  audioPlan?:
    | { mode: 'copy'; codec: string }
    | {
        mode: 'transcode';
        codec: 'aac' | 'ac3' | 'eac3';
        bitrateBps: number;
      };
  encoderPreset?: string;
  qsvOptions?: { lowPower: boolean };
  sourceFps?: number;
  trustedStreamInfo?: boolean;
  /** Short-lived parallel session producing only seg-0/seg-1 during a
   *  mid-file resume. Trades visual quality on the discarded warm-up frames
   *  for ramp-up speed: fastest encoder preset + reduced rate-control
   *  buffer so the first frame ships sooner. */
  early?: boolean;
  /** When true, emit MPEG-TS segments instead of fMP4. Used for Chromecast
   *  sessions to avoid the priming desync caused by the Cast receiver
   *  ignoring the init fMP4 `edts/elst` atom. */
  useTs?: boolean;
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
    audioStreams,
    audioPlan,
    encoderPreset = 'faster',
    qsvOptions = { lowPower: false },
    sourceFps,
    trustedStreamInfo = false,
    early = false,
    useTs = false,
  } = opts;

  // Segment container choice. Cast → MPEG-TS (fixes the priming desync
  // because TS packets carry per-frame PTS and there's no init fMP4 atom
  // for the receiver to honour or ignore). Everyone else → fMP4 (better
  // for HEVC / DASH-like manifests on Shaka & MSE).
  const segType = useTs ? 'mpegts' : 'fmp4';
  const segExt = useTs ? 'ts' : 'm4s';

  const SEGMENT_DURATION = getSegmentDuration();

  // Audio output args derived from the stream-builder decision. No
  // re-derivation here — we just emit what we were told. Safe fallback to
  // AAC stereo when no plan is supplied (legacy call sites).
  const audioArgs: string[] = (() => {
    if (audioPlan?.mode === 'copy') return ['-c:a', 'copy'];
    const codec = audioPlan?.mode === 'transcode' ? audioPlan.codec : 'aac';
    if (codec === 'aac') {
      return ['-c:a', 'aac', '-b:a', profile.audioBitrate, '-ac', '2'];
    }
    // EAC-3 / AC-3 keep source channels (no `-ac`) at 640 kbps.
    return ['-c:a', codec, '-b:a', '640k'];
  })();

  // GOP = segment_duration × fps so each segment starts exactly on an IDR.
  // Fallback to 24 fps when source fps is unknown (safe for most content).
  const fps = sourceFps && sourceFps > 0 ? sourceFps : 24;
  const gopSize = Math.max(1, Math.round(SEGMENT_DURATION * fps));

  // Resume point for mid-file seek (`startSegment > 0`). Seek to T,
  // then `-copyts` (set after `-i` below) threads source PTS through
  // to the muxer so the first segment lands at tfdt = T × timescale.
  const seekSeconds = startSegment > 0 ? segmentIndexToSeconds(startSegment) : 0;

  // Force an IDR every `SEGMENT_DURATION` seconds so the HLS muxer can
  // cut segments on a uniform grid. On a seek-resume we use `-copyts`
  // so the encoder's `t` is in source time — the expression anchors at
  // `seekSeconds` and IDRs land on the same grid as before the seek.
  const forceKeyframesExpr = `expr:gte(t,${seekSeconds}+n_forced*${SEGMENT_DURATION})`;
  // Closed-GOP, deterministic IDR placement on h264_qsv:
  //  - `-forced_idr 1` : every `force_key_frames` tick lands as a real
  //    IDR (without it, qsvenc emits some as plain I, breaking HLS
  //    segment cuts).
  //  - `-adaptive_i 0` : scene-cut detection off — its placement fights
  //    with the forced-IDR cadence we want.
  //  - `-bf 0 -b_strategy 0` : no B-frames, no reordering across
  //    segment edges → HLS muxer can cut cleanly on each forced IDR.
  // See `docs/streaming/encoder-stability.md` for the full rationale.
  const qsvExtra: string[] = [
    '-forced_idr', '1',
    '-adaptive_i', '0',
    '-bf', '0',
    '-b_strategy', '0',
  ];
  if (qsvOptions.lowPower) {
    qsvExtra.push('-low_power', '1');
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

  if (startSegment > 0) {
    // Single input-seek to T. The demuxer snaps each stream to its own
    // frame boundary ≤ T (≤ 21 ms for AAC, 32 ms for AC-3, 40 ms for
    // DTS); `-copyts` (set after `-i` below) threads the source PTS
    // straight through to the muxer so the first emitted segment's
    // tfdt = seekSeconds × timescale and the player picks up the
    // playlist boundary cleanly.
    args.push('-ss', String(seekSeconds));
  }

  // parseBitrateToBps handles both "8M" and "200k" correctly. Using parseInt()*1e6
  // would give 200 Mbps for "200k" (it drops the suffix and multiplies as if M).
  const bitrateNum = parseBitrateToBps(profile.videoBitrate);

  // Force pipeline adjustments when HW accel can't handle required filters:
  // - Subtitle burn-in forces CPU for QSV/VAAPI/NVENC (filters need CPU surfaces)
  //   but NOT for VideoToolbox — VT decode already outputs CPU buffers, so
  //   libswscale filters (including subtitle overlay) work in-place.
  // - QSV can't crop (fixed-size pool constraint), fallback to VAAPI encode
  const effectiveHwAccel: HwAccelType = burnIn?.filter && hwAccel !== 'videotoolbox'
    ? 'none'
    : hwAccel === 'qsv' && crop
      ? 'vaapi'
      : hwAccel;

  // Early sessions live ~1s before Shaka jumps to the main session — visual
  // quality on those warm-up frames is throwaway, so bias every knob towards
  // ramp-up speed. Per-encoder mapping since 'ultrafast' is libx264-only,
  // QSV stops at 'veryfast', NVENC uses p1..p7, VAAPI ignores -preset.
  const earlyPreset = early
    ? effectiveHwAccel === 'qsv'
      ? 'veryfast'
      : 'ultrafast'
    : encoderPreset;
  const earlyNvencPreset = early ? 'p1' : 'p4';
  // QSV rate-control: tight VBV (bufsize = bitrate × 1) so the BRC has a
  // short horizon and can't defer big I-frames. Early uses 0.5× / 1× so
  // the encoder doesn't hold back frames waiting for the buffer to fill.
  // Recommended by Intel media-delivery quality.rst for HLS streaming.
  const qsvRcInitOccupancy = Math.max(
    1,
    early ? Math.round(bitrateNum * 0.5) : bitrateNum,
  );
  const qsvBufsize = bitrateNum;
  // libx264 -bufsize is expressed in Mbits. Stock = 2x bitrate, early = 1x.
  const libx264BufsizeMb = `${Math.max(1, parseInt(profile.videoBitrate) * (early ? 1 : 2))}M`;

  // tonemap_vaapi keeps the pipeline inside VAAPI (1 device transition, no
  // OpenCL kernel compile) — saves ~300-500ms cold-start on HDR. Quality is
  // slightly worse than tonemap_opencl/reinhard, but the early session's
  // output is jumped past by Shaka after ~1s, so the user never sees those
  // frames in steady-state. Restricted to early on HW paths that have a
  // VAAPI decoder (qsv on Linux derives from vaapi, so it qualifies too).
  const useVaapiTonemap =
    early && tonemap && (effectiveHwAccel === 'qsv' || effectiveHwAccel === 'vaapi');

  // Hardware acceleration input decoding
  if (effectiveHwAccel === 'qsv') {
    // Linux approach: decode with VAAPI (native), scale with VAAPI,
    // then map to QSV surfaces for encoding. More compatible than pure QSV pipeline.
    args.push(
      '-init_hw_device', 'vaapi=va:/dev/dri/renderD128',
      '-init_hw_device', 'qsv=qs@va',
    );
    if (tonemap && !useVaapiTonemap) {
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
    if (tonemap && !useVaapiTonemap) {
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
  } else if (effectiveHwAccel === 'videotoolbox') {
    // VideoToolbox = Apple Media Engine (h264/hevc encode+decode ASIC).
    // No `-hwaccel_output_format` — let ffmpeg implicitly hwdownload to
    // CPU buffers after decode. Stock libswscale `scale` filter doesn't
    // accept VT surfaces, and the encoder takes CPU YUV input and
    // re-uploads internally. No /dev/dri probing — the framework picks
    // the host's Media Engine automatically on macOS.
    args.push('-hwaccel', 'videotoolbox', '-noautorotate');
  }

  args.push('-i', inputPath);

  // Preserve source PTS end-to-end on every spawn (see
  // docs/streaming/encoder-stability.md). Required so subtitle cues —
  // timed in source PTS by external sidecar / extraction — line up
  // with the muxed segments; without it the fmp4 muxer's default
  // `avoid_negative_ts auto` shifts the timeline whenever the source
  // has an audio `start_time` offset (common on MKV to compensate
  // for codec priming), breaking subtitle alignment and creating
  // hard-to-track A/V skew on some receivers.
  args.push('-copyts', '-muxdelay', '0', '-muxpreload', '0');

  if (startSegment > 0) {
    // Output-seek after `-i`: with `-copyts` it operates in source-time
    // and drops decoded video frames before `seekSeconds`, so the
    // encoder's mandatory first IDR lands at T instead of on the
    // source keyframe ≤ T (the HW-decode path's `accurate_seek`
    // discard pass doesn't always trim frames on VAAPI surfaces).
    // Audio keeps its ±21–40 ms packet-snap drift (intrinsic to
    // demuxer seek on a packetised stream).
    args.push('-ss', String(seekSeconds));
  }

  // Video encoding
  const w = profile.maxWidth;
  const cropStr = crop
    ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`
    : '';
  const cpuCropPrefix = cropStr ? `${cropStr},` : '';
  const burnInFilter = burnIn?.filter ? `,${burnIn.filter}` : '';
  const tonemapOpencl =
    tonemap && !useVaapiTonemap && !burnIn?.filter
      ? ',hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0'
      : '';
  const tonemapVaapi =
    useVaapiTonemap && !burnIn?.filter
      ? ',tonemap_vaapi=format=nv12:t=bt709:p=bt709:m=bt709'
      : '';
  // CPU tonemap chain: HDR (PQ/HLG BT.2020) → SDR (BT.709).
  // convert to float → tonemap → back to yuv420p. The `tonemap` filter
  // handles PQ/HLG linearisation internally. No zscale/libzimg dependency
  // (not available in stock Homebrew FFmpeg on macOS).
  const tonemapCpu = tonemap
    ? `format=gbrpf32le,tonemap=mobius:desat=0,format=yuv420p,`
    : '';

  // For HW paths with crop: hwdownload to CPU, crop, then hwupload back.
  const hwCropPrefix = cropStr
    ? `hwdownload,format=nv12,${cropStr},hwupload=derive_device=vaapi,`
    : '';

  switch (effectiveHwAccel) {
    case 'qsv':
      // Note: QSV + crop is forced to CPU via effectiveHwAccel (fixed-size pool constraint)
      if (tonemapVaapi) {
        // VAAPI decode → VAAPI scale → VAAPI tonemap → QSV encode (no OpenCL hop)
        args.push(
          '-c:v', 'h264_qsv',
          '-preset', earlyPreset,
          ...qsvExtra,
          '-mbbrc', '1',
          '-b:v', String(bitrateNum),
          '-maxrate', String(bitrateNum + 1),
          '-rc_init_occupancy', String(qsvRcInitOccupancy),
          '-bufsize', String(qsvBufsize),
          '-vf',
          `scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${tonemapVaapi},hwmap=derive_device=qsv,format=qsv`,
          '-g', String(gopSize),
          '-keyint_min', String(gopSize),
          '-force_key_frames', forceKeyframesExpr,
        );
      } else if (tonemapOpencl) {
        // VAAPI decode → VAAPI scale → OpenCL tonemap → map to QSV → QSV encode
        args.push(
          '-c:v', 'h264_qsv',
          '-preset', earlyPreset,
          ...qsvExtra,
          '-mbbrc', '1',
          '-b:v', String(bitrateNum),
          '-maxrate', String(bitrateNum + 1),
          '-rc_init_occupancy', String(qsvRcInitOccupancy),
          '-bufsize', String(qsvBufsize),
          '-vf',
          `scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${tonemapOpencl},hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv`,
          '-g', String(gopSize),
          '-keyint_min', String(gopSize),
          '-force_key_frames', forceKeyframesExpr,
        );
      } else {
        args.push(
          '-c:v', 'h264_qsv',
          '-preset', earlyPreset,
          ...qsvExtra,
          '-mbbrc', '1',
          '-b:v', String(bitrateNum),
          '-maxrate', String(bitrateNum + 1),
          '-rc_init_occupancy', String(qsvRcInitOccupancy),
          '-bufsize', String(qsvBufsize),
          '-vf',
          `scale_vaapi=w=${w}:h=-16:format=nv12:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv`,
          '-g', String(gopSize),
          '-keyint_min', String(gopSize),
          '-force_key_frames', forceKeyframesExpr,
        );
      }
      break;
    case 'vaapi':
      if (tonemapVaapi) {
        // VAAPI decode → VAAPI scale → VAAPI tonemap → VAAPI encode (single device)
        args.push(
          '-c:v', 'h264_vaapi',
          '-b:v', profile.videoBitrate,
          '-maxrate', profile.videoBitrate,
          '-vf',
          `${hwCropPrefix}scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${tonemapVaapi}`,
          '-g', String(gopSize),
          '-keyint_min', String(gopSize),
          '-force_key_frames', forceKeyframesExpr,
        );
      } else if (tonemapOpencl) {
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
          '-preset', earlyNvencPreset,
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
          '-preset', earlyNvencPreset,
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
    case 'videotoolbox':
      // h264_videotoolbox driven by Apple's Media Engine — H.264 High
      // profile L4.0 on Apple Silicon transcodes 4K @ 60 fps comfortably.
      // No `-preset` knob (VT doesn't expose presets); `-realtime 1`
      // tells the encoder to favour latency over efficiency on early
      // ramp-up frames.
      //
      // VT decode outputs CPU buffers (no `-hwaccel_output_format`), so
      // all CPU-side filters work in-place: zscale tonemap, subtitle
      // burn-in, crop, scale. The encoder re-uploads to Metal/IOSurface
      // internally.
      args.push(
        '-c:v', 'h264_videotoolbox',
        '-profile:v', 'high', '-level', '4.0',
        ...(early ? ['-realtime', '1'] : []),
        '-b:v', profile.videoBitrate,
        '-maxrate', profile.videoBitrate,
        '-vf',
        `${cpuCropPrefix}${tonemapCpu}scale=${w}:-2:flags=lanczos,format=yuv420p${burnInFilter}`,
        '-g', String(gopSize),
        '-keyint_min', String(gopSize),
        '-force_key_frames', forceKeyframesExpr,
      );
      break;
    default:
      args.push(
        '-c:v', 'libx264',
        // Cap frame-threading so segment 0 emits before a long (threads-1)-frame prebuffer.
        '-threads:v', '4',
        '-preset', earlyPreset,
        ...(early ? ['-tune', 'zerolatency'] : []),
        '-b:v', profile.videoBitrate,
        '-maxrate', profile.videoBitrate,
        '-bufsize', libx264BufsizeMb,
        '-vf',
        `${cpuCropPrefix}${tonemapCpu}scale=${w}:-2:flags=lanczos,format=yuv420p${burnInFilter}`,
        '-force_key_frames', forceKeyframesExpr,
        '-sc_threshold:v:0', '0',
      );
      break;
  }

  // ── Audio mapping + HLS output ──
  // Always use var_stream_map for multi-audio, even when the user has
  // picked a specific track — otherwise switching audio would require a
  // full backend reload. With all audio renditions exposed, Shaka switches
  // client-side via EXT-X-MEDIA. The picked track is signalled via
  // DEFAULT=YES in the master.m3u8 (see streaming.controller.ts).
  const userPickedAudio = audioStreamIndex != null && audioStreamIndex > 0;
  const useVarStreamMap =
    videoOnly && audioStreams && audioStreams.length > 1;

  if (useVarStreamMap) {
    // Single FFmpeg process for video + all audio renditions (perfect sync).
    if (!args.some((a) => a === '-map')) {
      args.push('-map', '0:v:0');
    }
    for (let i = 0; i < audioStreams.length; i++) {
      args.push('-map', `0:a:${i}`);
    }
    args.push(...audioArgs);

    // Build var_stream_map: "v:0,agroup:audio a:0,agroup:audio,language:fre ..."
    const varParts = ['v:0,agroup:audio'];
    for (let i = 0; i < audioStreams.length; i++) {
      const lang = audioStreams[i].language || 'und';
      varParts.push(`a:${i},agroup:audio,language:${lang}`);
    }

    args.push(
      '-f', 'hls',
      '-hls_time', String(SEGMENT_DURATION),
      '-hls_list_size', '0',
      '-start_number', String(startSegment),
      '-hls_segment_type', segType,
      ...(useTs ? [] : ['-hls_fmp4_init_filename', 'init_%v.mp4']),
      '-hls_flags', 'independent_segments',
      '-var_stream_map', varParts.join(' '),
      '-hls_segment_filename', path.join(outputDir, '%v', `seg-%04d.${segExt}`),
      path.join(outputDir, '%v', 'index.m3u8'),
    );
  } else {
    // Standard single-stream output: video + one audio track muxed.
    // When the user picked a track from the UI honour it; otherwise default
    // to the first audio. Explicit -map skips ffmpeg's auto-pick of a
    // subtitle stream — mandatory on sources with many subtitle tracks
    // (some HEVC MKVs have 28+) where the parallel subrip→webvtt pipeline
    // starves the VAAPI HEVC decoder buffer pool, making the early session
    // loop on "thread_get_buffer() failed".
    if (userPickedAudio) {
      args.push('-map', '0:v:0', '-map', `0:a:${audioStreamIndex}`);
    } else {
      args.push('-map', '0:v:0', '-map', '0:a:0');
    }
    args.push(...audioArgs);

    args.push(
      '-f', 'hls',
      '-hls_time', String(SEGMENT_DURATION),
      '-hls_list_size', '0',
      '-start_number', String(startSegment),
      '-hls_segment_type', segType,
      ...(useTs ? [] : ['-hls_fmp4_init_filename', 'init.mp4']),
      '-hls_segment_filename', path.join(outputDir, `seg-%04d.${segExt}`),
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
  useTs = false,
): string[] {
  const segType = useTs ? 'mpegts' : 'fmp4';
  const segExt = useTs ? 'ts' : 'm4s';
  const SEGMENT_DURATION = getSegmentDuration();

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

  const seekSeconds = startSegment > 0 ? segmentIndexToSeconds(startSegment) : 0;

  if (startSegment > 0) {
    args.push('-ss', String(seekSeconds));
  }

  args.push('-i', inputPath);

  // Preserve source PTS end-to-end on every spawn (see
  // `buildFfmpegArgs` for the full rationale) so audio renditions stay
  // anchored to the same timeline as the main video output.
  args.push('-copyts', '-muxdelay', '0', '-muxpreload', '0');

  if (startSegment > 0) {
    args.push('-ss', String(seekSeconds));
  }

  args.push('-map', `0:a:${audioStreamIndex}`);
  args.push('-vn');
  args.push('-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2');

  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_DURATION),
    '-hls_list_size', '0',
    '-start_number', String(startSegment),
    '-hls_segment_type', segType,
    ...(useTs ? [] : ['-hls_fmp4_init_filename', 'init.mp4']),
    '-hls_segment_filename', path.join(outputDir, `seg-%04d.${segExt}`),
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
  trustedStreamInfo = false,
  audioStreamIndex?: number,
  log?: Logger,
): string[] {
  const SEGMENT_DURATION = getSegmentDuration();

  const args = ['-hide_banner', '-loglevel', 'warning'];
  if (trustedStreamInfo) {
    log?.log('Probe [remux]: using cached streamInfo (0s / 200KB scan)');
    args.push('-analyzeduration', '0', '-probesize', '200000');
  } else {
    log?.log('Probe [remux]: no cached streamInfo — running full FFmpeg scan (1s / 1MB)');
    args.push('-analyzeduration', '1000000', '-probesize', '1000000');
  }

  const remuxSeekSeconds =
    startSegment > 0 ? segmentIndexToSeconds(startSegment) : 0;
  if (startSegment > 0) {
    args.push('-ss', String(remuxSeekSeconds));
  }

  args.push('-i', inputPath);

  // Preserve source PTS end-to-end on every spawn (see
  // `buildFfmpegArgs` for the full rationale).
  args.push('-copyts', '-muxdelay', '0', '-muxpreload', '0');

  if (startSegment > 0) {
    // Output-seek after `-i`: drops decoded frames < seekSeconds with
    // `-copyts` operating in source-time.
    args.push('-ss', String(remuxSeekSeconds));
  }

  const userPickedAudio = audioStreamIndex != null && audioStreamIndex > 0;
  if (videoOnly && !userPickedAudio) {
    // Video-only remux for var_stream_map (audio served separately).
    args.push('-map', '0:v:0', '-c:v', 'copy', '-an');
  } else if (userPickedAudio) {
    args.push('-map', '0:v:0', '-map', `0:a:${audioStreamIndex}`, '-c:v', 'copy');
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

  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_DURATION),
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
