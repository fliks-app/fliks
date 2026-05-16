import { Logger } from '@nestjs/common';
import * as path from 'path';
import { getSegmentDuration, segmentIndexToSeconds } from './constants';
import { isHdrProfile, parseBitrateToBps } from './profiles';
import { requestedHwAccelFor } from './hw-detect';
import type { BurnInSubtitle, HwAccelType, TranscodeProfile } from './types';
import { encoderRegistry } from './codec/encoders';
import type {
  BitDepth,
  CodecVariant,
  EncoderInput,
  VideoCodec,
} from './codec/types';
import { decoderRegistry, findQsvNativeDecoder } from './codec/decoders';
import { isDecoderEnabled } from './codec/decoder-probe';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
import { normaliseSourceCodec } from './codec/normalise';

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
  /** Output codec variant. Drives the encoder lookup via
   *  `encoderRegistry`. Required: a missing variant means the caller
   *  lost the master-playlist variant for this session, which would
   *  silently emit segments that contradict the manifest's CODECS
   *  string and trip MSE's chunk-demuxer. */
  videoVariant?: CodecVariant;
  /** Source video codec from ffprobe (`'h264'`, `'hevc'`, `'av1'`, plus
   *  aliases `'avc1'`, `'hev1'`, `'av01'`). Drives decoder selection
   *  via `decoderRegistry`. Falls back to CPU decode when omitted or
   *  unknown. */
  sourceVideoCodec?: string;
  /** Source bit depth (8 or 10). 10-bit HDR sources need a decoder
   *  that can handle p010le surfaces. Defaults to 8 when omitted. */
  sourceBitDepth?: BitDepth;
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
    videoVariant,
    sourceVideoCodec,
    sourceBitDepth = 8,
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
  const seekSeconds =
    startSegment > 0 ? segmentIndexToSeconds(startSegment) : 0;

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
    '-forced_idr',
    '1',
    '-adaptive_i',
    '0',
    '-bf',
    '0',
    '-b_strategy',
    '0',
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
    log.debug?.('Probe: using cached streamInfo (0s / 200KB scan)');
    args.push('-analyzeduration', '0', '-probesize', '200000');
  } else {
    // Keep the no-cache fallback at LOG — cold-start scans are expected
    // only on rescan / import races, so each one is worth surfacing.
    log.log(
      'Probe: no cached streamInfo — running full FFmpeg scan (1s / 1MB)',
    );
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

  // Pre-flight: can we keep the whole pipeline on QSV (decode + filter
  // + encode without bouncing through VAAPI)?
  //
  // Three sub-cases, all gated on `hwAccel === 'qsv'`, no burn-in
  // (libass needs CPU buffers) and a known source codec:
  //
  //   a. crop + !tonemap → qsv-native decoder + vpp_qsv crop/scale.
  //   b. tonemap + vpp_qsv tonemap probed enabled → qsv-native decoder
  //      + vpp_qsv with `tonemap=1` (single-pass HDR→SDR on the iGPU
  //      VPP, no hwmap, no opencl bridge). Available on Tiger Lake and
  //      later; the boot probe in `vpp-qsv-probe.ts` is the gate.
  //   c. crop + tonemap on older gens → still goes through the legacy
  //      vaapi-decode chain (scale_vaapi+tonemap_vaapi+hwmap=qsv), so
  //      we can stay on the QSV encoder via the hwCropPrefix splice.
  const normalisedSourceCodecPreflight = normaliseSourceCodec(sourceVideoCodec);
  const hasUsableQsvNativeDecoder =
    hwAccel === 'qsv' &&
    !burnIn?.filter &&
    normalisedSourceCodecPreflight != null &&
    isDecoderEnabled(`${normalisedSourceCodecPreflight}_qsv_native_decode`);
  const qsvNativeAvailable =
    hasUsableQsvNativeDecoder &&
    !!crop &&
    (!tonemap || isVppQsvTonemapEnabled());
  const qsvCanCrop =
    qsvNativeAvailable ||
    (hwAccel === 'qsv' && !!crop && !!tonemap && !burnIn?.filter);

  const requestedHwAccel = requestedHwAccelFor(hwAccel, {
    burnIn: !!burnIn?.filter,
    crop: !!crop,
    qsvCanCrop,
  });

  // Resolve the actual encoder before setting up the input pipeline.
  // The registry can downgrade to CPU when a HW encoder failed its
  // boot-time probe (e.g. h264_vaapi on a renderD node that exposes
  // only video-proc entrypoints). If we keep the HW input setup the
  // CPU encoder receives HW surfaces and the filter chain blows up
  // with `Function not implemented` / `Impossible to convert between
  // the formats supported by the filter`.
  //
  // `videoVariant` is required: callers must thread it from the
  // ActiveStreamTracker so the segment bitstream matches the master
  // playlist's CODECS string. Heuristic inference (profile name +
  // hwAccel) silently produced HEVC when the manifest claimed H.264
  // (or vice-versa) on cache misses — MSE then rejected the segments.
  // Fail fast so the player retries after the next playback-info call
  // repopulates the variant tracker.
  if (!videoVariant) {
    throw new Error(
      `buildFfmpegArgs: missing videoVariant for profile "${profile.name}" — caller must pass it from ActiveStreamTracker`,
    );
  }
  const variant: CodecVariant = videoVariant;
  const isHdrOutput = variant.hdr !== null;
  const encoder = encoderRegistry.resolve(variant, requestedHwAccel);
  if (!encoder) {
    throw new Error(
      `No encoder for variant ${JSON.stringify(variant)} on ${requestedHwAccel}`,
    );
  }
  const effectiveHwAccel: HwAccelType = encoder.hwAccel;

  // Early sessions live ~1s before Shaka jumps to the main session — visual
  // quality on those warm-up frames is throwaway, so bias every knob towards
  // ramp-up speed. `veryfast` everywhere keeps the H.264 profile consistent
  // with the steady-state session (`faster` → High); the libx264 `ultrafast`
  // preset implies `--no-cabac` which downgrades the bitstream to Constrained
  // Baseline and produces an SPS that doesn't match the High SPS in the
  // main session's init.mp4 — player concatenates the two and corrupts.
  const earlyPreset = early ? 'veryfast' : encoderPreset;
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
  // parseInt() drops ffmpeg's 'k'/'M' suffix silently — `parseInt('1500k')`
  // gives 1500, then ×2 + 'M' yields "3000M" = 3 Gbits and ffmpeg rejects
  // it as out-of-range. Derive Mbits from bitrateNum (already parsed via
  // parseBitrateToBps) so the multiplier sees real units.
  const libx264BufsizeMb = `${Math.max(
    1,
    Math.ceil((bitrateNum * (early ? 1 : 2)) / 1_000_000),
  )}M`;

  // tonemap_vaapi keeps the pipeline inside VAAPI (1 device transition, no
  // OpenCL kernel compile) — saves ~300-500ms cold-start on HDR. Quality is
  // slightly worse than tonemap_opencl/reinhard but the difference is
  // invisible at streaming bitrates.
  //
  // Force it on every QSV/VAAPI tonemap path. The OpenCL chain
  // (`hwmap=derive_device=opencl,tonemap_opencl,hwmap=...,format=qsv`)
  // depends on a working QSV↔OpenCL bridge that several Intel hosts
  // can't service — the driver returns 'QSV to OpenCL mapping not
  // usable' and the encoder crashes with exit=218. tonemap_vaapi has
  // no such dependency and runs end-to-end inside VAAPI / QSV.
  const useVaapiTonemap =
    tonemap && (effectiveHwAccel === 'vaapi' || effectiveHwAccel === 'qsv');

  // Resolve the decoder via the same registry pattern as the encoder.
  // The decoder picks how the source is brought into memory (HW device
  // init + `-hwaccel`); the encoder's `hwAccel` + `inputSurface` decide
  // where the frame needs to land for encode (qsv-native + vpp_qsv,
  // vaapi + scale_vaapi, CPU + hwdownload).
  const normalisedSourceCodec = normalisedSourceCodecPreflight;
  // Opt into the qsv-native decoder when the qsv crop path is in use
  // (pre-flighted above so requestedHwAccelFor could keep us on QSV).
  // The default qsv decoder emits VAAPI surfaces — kept as the safe
  // baseline for every other QSV path.
  const decoder: ReturnType<typeof decoderRegistry.resolve> =
    qsvNativeAvailable && effectiveHwAccel === 'qsv' && normalisedSourceCodec
      ? (findQsvNativeDecoder(normalisedSourceCodec) ??
        decoderRegistry.resolve(
          {
            codec: normalisedSourceCodec,
            bitDepth: sourceBitDepth,
          },
          effectiveHwAccel,
        ))
      : decoderRegistry.resolve(
          {
            codec: normalisedSourceCodec ?? 'h264',
            bitDepth: sourceBitDepth,
          },
          effectiveHwAccel,
        );
  args.push(...decoder.buildInputArgs());

  // OpenCL device init for the tonemap_opencl filter chain. Only needed
  // when (a) we're tonemapping HDR→SDR AND (b) the VAAPI in-place
  // tonemap fallback isn't active AND (c) the decoder's output sits on
  // VAAPI surfaces — the only path that uses the opencl bridge today.
  if (tonemap && !useVaapiTonemap && decoder.outputSurface === 'vaapi') {
    args.push('-init_hw_device', 'opencl=ocl:0.0', '-filter_hw_device', 'ocl');
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

  const encoderInput: EncoderInput = {
    source: {
      width: 0,
      height: 0,
      hdr: null,
      bitDepth: 8,
      codecName: '',
    },
    variant,
    target: {
      width: w,
      height: profile.maxHeight,
      videoBitrateBps: bitrateNum,
      gopSize,
      frameRate: fps,
    },
    preset: earlyPreset,
    nvencPreset: earlyNvencPreset,
    seekSeconds,
    early,
    forceKeyframesExpr,
    qsv: {
      extra: qsvExtra,
      rcInitOccupancy: qsvRcInitOccupancy,
      bufsize: qsvBufsize,
    },
    libx264BufsizeMb,
    filters: {
      cropStr,
      cpuCropPrefix,
      hwCropPrefix,
      burnInFilter,
      tonemapVaapi,
      tonemapOpencl,
      tonemapCpu,
    },
    tonemap,
    hasBurnIn: !!burnIn?.filter,
    hasCrop: !!crop,
    inputSurface: decoder.outputSurface,
  };
  args.push(...encoder.buildArgs(encoderInput));

  // When tone-mapping HDR → SDR on the H.264 path, force the SPS VUI to
  // BT.709 limited range. The pixel data is genuinely SDR after the
  // tonemap filter, but some encoder paths (notably h264_qsv) carry the
  // source's BT.2020/PQ color tags through from input AVFrame metadata
  // into the SPS, producing a bitstream that signals HDR with SDR
  // pixels. iOS AVPlayer rejects this combination with -12927; other
  // players tolerate it but render with wrong color. These flags are
  // a no-op when tone-mapping isn't active (the AVFrame already has
  // BT.709 tags on SDR sources).
  if (tonemap && !isHdrOutput) {
    args.push(
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      '-color_range',
      'tv',
    );
  }

  // ── Audio mapping + HLS output ──
  // Always use var_stream_map for multi-audio, even when the user has
  // picked a specific track — otherwise switching audio would require a
  // full backend reload. With all audio renditions exposed, Shaka switches
  // client-side via EXT-X-MEDIA. The picked track is signalled via
  // DEFAULT=YES in the master.m3u8 (see streaming.controller.ts).
  const userPickedAudio = audioStreamIndex != null && audioStreamIndex > 0;
  const useVarStreamMap = videoOnly && audioStreams && audioStreams.length > 1;

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
      '-f',
      'hls',
      '-hls_time',
      String(SEGMENT_DURATION),
      '-hls_list_size',
      '0',
      '-start_number',
      String(startSegment),
      '-hls_segment_type',
      segType,
      ...(useTs ? [] : ['-hls_fmp4_init_filename', 'init_%v.mp4']),
      '-hls_flags',
      'independent_segments',
      '-var_stream_map',
      varParts.join(' '),
      '-hls_segment_filename',
      path.join(outputDir, '%v', `seg-%04d.${segExt}`),
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
      '-f',
      'hls',
      '-hls_time',
      String(SEGMENT_DURATION),
      '-hls_list_size',
      '0',
      '-start_number',
      String(startSegment),
      '-hls_segment_type',
      segType,
      ...(useTs ? [] : ['-hls_fmp4_init_filename', 'init.mp4']),
      '-hls_segment_filename',
      path.join(outputDir, `seg-%04d.${segExt}`),
      '-hls_flags',
      'independent_segments',
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
    log.debug?.(
      'Probe [audio-only]: using cached streamInfo (0s / 200KB scan)',
    );
    args.push('-analyzeduration', '0', '-probesize', '200000');
  } else {
    log.log(
      'Probe [audio-only]: no cached streamInfo — running full FFmpeg scan (1s / 1MB)',
    );
    args.push('-analyzeduration', '1000000', '-probesize', '1000000');
  }

  const seekSeconds =
    startSegment > 0 ? segmentIndexToSeconds(startSegment) : 0;

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
    '-f',
    'hls',
    '-hls_time',
    String(SEGMENT_DURATION),
    '-hls_list_size',
    '0',
    '-start_number',
    String(startSegment),
    '-hls_segment_type',
    segType,
    ...(useTs ? [] : ['-hls_fmp4_init_filename', 'init.mp4']),
    '-hls_segment_filename',
    path.join(outputDir, `seg-%04d.${segExt}`),
    '-hls_flags',
    'independent_segments',
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
  /** Source video codec (ffprobe `codec_name`, lowercased). Drives the
   *  `-tag:v hvc1` flag for HEVC inputs — FFmpeg's mov muxer otherwise
   *  defaults to `hev1`, which Apple HLS rejects: the spec requires
   *  parameter sets in the moov sample description (`hvc1`), not inline
   *  in the bitstream (`hev1`). Without this, iOS AVPlayer fails the
   *  variant with error -12927 on the first segment fetch. */
  sourceVideoCodec?: string,
): string[] {
  const SEGMENT_DURATION = getSegmentDuration();

  const args = ['-hide_banner', '-loglevel', 'warning'];
  if (trustedStreamInfo) {
    log?.log('Probe [remux]: using cached streamInfo (0s / 200KB scan)');
    args.push('-analyzeduration', '0', '-probesize', '200000');
  } else {
    log?.log(
      'Probe [remux]: no cached streamInfo — running full FFmpeg scan (1s / 1MB)',
    );
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

  // No output-side `-ss` here. The transcode path needs it because
  // `-ss <T> -i input` with HW decode (VAAPI) doesn't reliably drop the
  // [last_keyframe ≤ T, T) frame range before the encoder's mandatory
  // first IDR (see `encoder-stability.md` issue 2b). Remux is `-c:v copy`
  // — no decode → no frame range to drop, and `-ss` at the output side
  // turns into a packet-level PTS filter that breaks the GOP (drops
  // non-keyframe packets that depend on the last source keyframe). The
  // pre-`-i` seek above lands on the source IDR cleanly via demuxer
  // index lookup; that's all remux needs.

  const userPickedAudio = audioStreamIndex != null && audioStreamIndex > 0;
  if (videoOnly && !userPickedAudio) {
    // Video-only remux for var_stream_map (audio served separately).
    args.push('-map', '0:v:0', '-c:v', 'copy', '-an');
  } else if (userPickedAudio) {
    args.push(
      '-map',
      '0:v:0',
      '-map',
      `0:a:${audioStreamIndex}`,
      '-c:v',
      'copy',
    );
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

  // HEVC needs Apple HLS conformance:
  //   - `-tag:v hvc1` writes parameter sets to the moov sample
  //     description; FFmpeg defaults to `hev1` (parameter sets inline
  //     in mdat) which AVPlayer rejects on HLS.
  //   - `-bsf:v hevc_mp4toannexb` converts NAL units from mp4-style
  //     length-prefixed to annex-B start-code form, which is what the
  //     fmp4 muxer expects when emitting parameter sets to moov.
  //   - `-max_muxing_queue_size 2048` doubles the default per-stream
  //     packet buffer. HEVC GOPs (12-16 frames between IDRs) plus
  //     non-AAC audio inter-frame intervals (TrueHD, DTS) can
  //     overflow the default 1024-packet queue and crash the mux
  //     with "Too many packets buffered for output stream".
  if (sourceVideoCodec === 'hevc') {
    args.push(
      '-tag:v',
      'hvc1',
      '-bsf:v',
      'hevc_mp4toannexb',
      '-max_muxing_queue_size',
      '2048',
    );
  }

  args.push(
    '-f',
    'hls',
    '-hls_time',
    String(SEGMENT_DURATION),
    '-hls_list_size',
    '0',
    '-start_number',
    String(startSegment),
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    path.join(outputDir, 'seg-%04d.m4s'),
    '-hls_flags',
    'independent_segments',
    path.join(outputDir, 'index.m3u8'),
  );

  return args;
}
