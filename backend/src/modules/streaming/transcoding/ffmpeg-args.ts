import { Logger } from '@nestjs/common';
import * as path from 'path';
import {
  getSegmentDuration,
  realSegmentSeconds,
  segmentIndexToSeconds,
} from './constants';
import {
  cappedTranscodeVideoBitrateBps,
  isHdrProfile,
  parseBitrateToBps,
  profileResolution,
  SURROUND_TRANSCODE_BITRATE_BPS,
} from './profiles';
import type {
  AudioStreamMeta,
  BurnInSubtitle,
  HwAccelType,
  TonemapAlgo,
  TranscodeProfile,
} from './types';
import type {
  BitDepth,
  CodecVariant,
  EncoderInput,
  HdrStaticMetadata,
  VideoCodec,
} from './codec/types';
import {
  decoderRegistry,
  findQsvNativeDecoder,
  findAmfNativeDecoder,
} from './codec/decoders';
import { normaliseSourceCodec } from './codec/normalise';
import { hevcMainTierCapBps } from './codec/codec-strings';
import { varStreamMapLayout } from './audio-layout';
import { resolveEncodePipeline } from './encode-pipeline';
import { openclTonemapInitArgs } from './hw-device';
import { buildVideoFilters, resolveTonemapCurve } from './ffmpeg-filter-graph';
import { isOpenclTonemapEnabled } from './codec/opencl-tonemap-probe';
import { isLibplaceboDvEnabled } from './codec/libplacebo-dv-probe';
import { buildImageBurnInFilterComplex } from './subtitle-overlay-filter';

/**
 * Probe ceiling (bytes) for the trusted-streamInfo fast path. Paired with
 * `-analyzeduration 0` so it stays a read *ceiling*, not a target — FFmpeg
 * stops as soon as it has stream parameters, keeping cold-start open time at
 * the same ~70 ms regardless of the value.
 *
 * 5 MB rather than a few hundred KB because AV1-in-Matroska needs the demuxer
 * to ingest enough of the bitstream up front to set the decoder up for a
 * mid-file input seek. Under ~3 MB the demuxer delivers no decodable sequence
 * after `-ss`, the decoder emits zero frames, and the HLS muxer writes no
 * segments — every resume/scrub on such a source stalls. The larger ceiling
 * is read only when the demuxer actually needs it, so it carries no measurable
 * startup cost on the common (small-header) case.
 */
const TRUSTED_PROBE_SIZE = '5000000';

/** Join an HLS output path with forward slashes. ffmpeg's HLS muxer derives
 *  the fmp4 init directory with POSIX separators, so a backslash path (what
 *  path.join yields on Windows) makes it silently skip writing init_%v.mp4 —
 *  the player then stalls waiting for EXT-X-MAP. ffmpeg accepts forward slashes
 *  on Windows, and this matches path.join's output on POSIX. */
function ffOutPath(...parts: string[]): string {
  return parts.join('/').replace(/\\/g, '/');
}

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
  /** Audio streams from the cached `streamInfo`. See {@link AudioStreamMeta}. */
  audioStreams?: AudioStreamMeta[];
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
  /** Source frame dimensions (post container crop / SAR). Drive the
   *  aspect-preserving output sizing in `buildFfmpegArgs` — required
   *  for non-16:9 sources (cinemascope, vertical, …) so the encoder's
   *  explicit `h=…` filter argument matches the actual frame instead
   *  of stretching to `profile.maxHeight`. When omitted, the output
   *  defaults to the profile's raw `maxWidth × maxHeight`. */
  sourceWidth?: number;
  sourceHeight?: number;
  /** Probed (or estimated) source video bitrate in bps. Caps the rung target
   *  so a forced transcode never inflates the bitrate above the source — see
   *  {@link cappedTranscodeVideoBitrateBps}. Omitted → no cap. */
  sourceVideoBitrateBps?: number;
  /** Source HDR10 static metadata (mastering display + content light), probed
   *  from the source. Fed into the encoder's master-display / max-cll so the
   *  display tonemaps to the real peak luminance; the encoders fall back to a
   *  generic 1000-nit reference when absent. */
  sourceHdrMetadata?: HdrStaticMetadata;
  /** Dolby Vision profile + base-layer compat id — gate the P5 libplacebo
   *  tonemap (#636). */
  sourceDvProfile?: number;
  sourceDvBlSignalCompatId?: number;
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
  /** Per-rendition audio decision for the multi-audio `var_stream_map` path,
   *  one entry per `audioStreams[]` track in the same order. The group shares
   *  one output codec; each rendition gets its own `-c:a:N` (copy when its
   *  source already is that codec, else transcode, downmixed to
   *  `outputChannels`). Omitted → the single `audioPlan` applies to all. */
  audioTrackPlans?: {
    copy: boolean;
    outputCodec: string;
    outputChannels?: number;
  }[];
  encoderPreset?: string;
  qsvOptions?: { lowPower: boolean };
  /** HDR → SDR tone-mapping algorithm (admin override). Defaults to `'auto'`
   *  which preserves the historical vaapi-when-available preference. */
  tonemapAlgo?: TonemapAlgo;
  sourceFps?: number;
  trustedStreamInfo?: boolean;
  /** Short-lived parallel session producing only seg-0/seg-1 during a
   *  mid-file resume. Trades visual quality on the discarded warm-up frames
   *  for ramp-up speed: fastest encoder preset + reduced rate-control
   *  buffer so the first frame ships sooner. */
  early?: boolean;
  /** When true, emit MPEG-TS segments instead of fMP4. Used for Tizen TV
   *  sessions where AVPlay rejects the HLS muxer's fMP4 output (`iso5`
   *  brand + per-stream `sidx` boxes — see issue #148) with
   *  `InvalidAccessError` / `PLAYER_ERROR_CONNECTION_FAILED`. MPEG-TS
   *  side-steps the issue at the cost of Dolby passthrough and a clean
   *  HDR path. Cast, browser and native mobile all stay on fMP4. */
  useTs?: boolean;
}

/**
 * Resolve the `-map` value for an audio track, preferring the absolute
 * ffprobe `streamIndex` over the relative `0:a:N` shorthand. The `?`
 * suffix on the relative fallback keeps FFmpeg from hard-failing when
 * the audio is missing or unprobeable.
 */
function audioMapSpec(
  streams: AudioStreamMeta[] | undefined,
  relIndex: number,
): string {
  const abs = streams?.[relIndex]?.streamIndex;
  return abs != null ? `0:${abs}` : `0:a:${relIndex}?`;
}

/** True iff the cached streamInfo explicitly reports zero audio streams. */
function hasNoAudio(streams: AudioStreamMeta[] | undefined): boolean {
  return streams != null && streams.length === 0;
}

/**
 * Per-output-stream audio codec args for the multi-audio `var_stream_map`
 * path, indexed to match the `-map 0:a:i` order. Returns `null` only when
 * there are no per-track plans (or a length mismatch) — then the caller keeps
 * the single `-c:a` form. The group's output codec is uniform (HLS CODECS
 * requirement), but copy and transcode mix per rendition: a track already in
 * the output codec copies; the rest re-encode, downmixed to `outputChannels`.
 *
 * Every per-stream option uses the audio-relative specifier (`-c:a:i`,
 * `-b:a:i`, `-ac:a:i`): the muxed output carries the video at stream 0, so a
 * bare `-ac:i` would target the wrong output stream and leave the last
 * rendition at its source channel count.
 */
export function perStreamAudioArgs(
  audioStreams: AudioStreamMeta[],
  plans:
    | { copy: boolean; outputCodec: string; outputChannels?: number }[]
    | undefined,
  aacBitrate: string,
): string[] | null {
  if (!plans || plans.length !== audioStreams.length) return null;
  const out: string[] = [];
  plans.forEach((p, i) => {
    if (p.copy) {
      out.push(`-c:a:${i}`, 'copy');
      return;
    }
    if (p.outputCodec === 'aac') {
      out.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, aacBitrate, `-ac:a:${i}`, '2');
      return;
    }
    if (p.outputCodec === 'opus') {
      // libopus, downmixed to the planned channel count. 256k is transparent
      // for 5.1 (Opus is far more efficient than EAC-3 at the same quality).
      out.push(`-c:a:${i}`, 'libopus', `-b:a:${i}`, '256k');
      if (p.outputChannels != null) {
        out.push(`-ac:a:${i}`, String(p.outputChannels));
      }
      return;
    }
    // EAC-3 / AC-3 at the surround ceiling, downmixed to the planned count (≤ 5.1).
    out.push(
      `-c:a:${i}`,
      p.outputCodec,
      `-b:a:${i}`,
      `${SURROUND_TRANSCODE_BITRATE_BPS / 1000}k`,
    );
    if (p.outputChannels != null) {
      out.push(`-ac:a:${i}`, String(p.outputChannels));
    }
  });
  return out;
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
    audioTrackPlans,
    encoderPreset = 'faster',
    qsvOptions = { lowPower: false },
    sourceFps,
    trustedStreamInfo = false,
    early = false,
    useTs = false,
    videoVariant,
    sourceVideoCodec,
    sourceVideoBitrateBps,
    sourceBitDepth = 8,
    sourceWidth = 0,
    sourceHeight = 0,
    sourceHdrMetadata,
    sourceDvProfile,
    sourceDvBlSignalCompatId,
    tonemapAlgo = 'auto',
  } = opts;

  // Segment container choice. `useTs` stays as the emergency fallback
  // for Tizen AVPlay quirks (issue #148); the post-process rewrite in
  // `cmaf-rewrite.ts` makes the fMP4 path consumable on every target
  // we ship, so `useTs` defaults to false everywhere.
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
    // EAC-3 / AC-3 at the surround ceiling, downmixed to 5.1 (the encoders'
    // max): keeps surround within the device cap and stops a 7.1 source from
    // failing to open (FFmpeg's eac3/ac3 encoders reject > 6 channels).
    return [
      '-c:a',
      codec,
      '-b:a',
      `${SURROUND_TRANSCODE_BITRATE_BPS / 1000}k`,
      '-ac',
      '6',
    ];
  })();

  // GOP = segment_duration × fps so each segment starts exactly on an IDR.
  // Fallback to 24 fps when source fps is unknown (safe for most content).
  const fps = sourceFps && sourceFps > 0 ? sourceFps : 24;
  const gopSize = Math.max(1, Math.round(SEGMENT_DURATION * fps));
  // Real segment length on the wire (gop/fps). The seek grid, the force-IDR
  // cadence, the playlist EXTINF and the fMP4 tfdt all anchor on this so they
  // agree on fractional-fps sources. Equals SEGMENT_DURATION for integer fps.
  const realSeg = realSegmentSeconds(sourceFps);

  // Resume point for mid-file seek (`startSegment > 0`). Seek to T,
  // then `-copyts` (set after `-i` below) threads source PTS through
  // to the muxer so the first segment lands at tfdt = T × timescale.
  const seekSeconds =
    startSegment > 0 ? segmentIndexToSeconds(startSegment, sourceFps) : 0;

  // Force an IDR every `realSeg` seconds so the HLS muxer cuts on the same grid
  // the playlist declares. `-copyts` keeps the encoder's `t` in source time, so
  // the expression anchors at `seekSeconds` and IDRs survive a seek-resume.
  const forceKeyframesExpr = `expr:gte(t,${seekSeconds}+n_forced*${realSeg})`;
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
    log.debug?.('Probe: using cached streamInfo (0s / 5MB ceiling)');
    args.push('-analyzeduration', '0', '-probesize', TRUSTED_PROBE_SIZE);
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

  // Output dimensions cap the source aspect to the profile's `maxWidth`.
  // `vpp_qsv` / `scale_qsv` don't honour the `-2` auto-height token, so a
  // 2.39:1 cinemascope title (1920×804) needs its height computed up front to
  // land at 1920×804 instead of being stretched to 1920×1080 by an explicit
  // `h=maxHeight`. The result matches the RESOLUTION attribute the master
  // playlist already advertises for this rung — display aspect stays stable
  // across the session even if the player re-parses the manifest. Resolved here
  // (ahead of the bitrate) so the HEVC Main-tier clamp below can use it.
  // When an auto-crop trims the source frame the encoder scales the CROPPED
  // picture, so the output size must follow the crop dimensions — otherwise a
  // horizontal (pillarbox) crop scales back up to the uncropped width and the
  // bitstream's RESOLUTION and codec level overshoot what the master playlist
  // declares for this rung (the master already sizes from the crop). A
  // letterbox crop keeps the source width, so its output width is unchanged.
  const framedWidth = crop ? crop.width : sourceWidth;
  const framedHeight = crop ? crop.height : sourceHeight;
  const outDims =
    framedWidth > 0 && framedHeight > 0
      ? profileResolution(profile, framedWidth, framedHeight)
      : { width: profile.maxWidth, height: profile.maxHeight };
  const w = outDims.width;
  const h = outDims.height;

  // parseBitrateToBps handles both "8M" and "200k" correctly. Using parseInt()*1e6
  // would give 200 Mbps for "200k" (it drops the suffix and multiplies as if M).
  // Capped to the source bitrate (codec-aware) so a forced transcode never
  // inflates a low-bitrate source up to the rung's nominal target.
  let bitrateNum = cappedTranscodeVideoBitrateBps(
    parseBitrateToBps(profile.videoBitrate),
    sourceVideoBitrateBps,
    sourceVideoCodec,
    videoVariant?.codec ?? sourceVideoCodec,
  );
  // HEVC declares the Main tier (`L<level>`) in the manifest CODECS string, but
  // the encoder flips `general_tier_flag` to High when the rate exceeds the
  // level's Main-tier ceiling — a High-tier bitstream behind a Main-tier
  // manifest claim is rejected by strict hardware MediaCodec decoders (surfaces
  // as Shaka 3014). Clamp HEVC rungs to the Main-tier ceiling so the bitstream
  // stays Main and matches the declared `L<level>`. Runs before the VBV bufsize
  // derivations below so they size to the capped rate.
  if (videoVariant?.codec === 'hevc') {
    bitrateNum = Math.min(
      bitrateNum,
      hevcMainTierCapBps({
        width: w,
        height: h,
        videoBitrateBps: 0,
        gopSize: 0,
        frameRate: fps,
      }),
    );
  }

  // `videoVariant` is required: callers thread it from the LiveSession so the
  // segment bitstream matches the master playlist's CODECS string. Heuristic
  // inference once produced HEVC when the manifest claimed H.264 (or vice
  // versa) on cache misses → MSE rejected the segments. HLS 410-gates stale
  // sids upstream; reaching this throw means a non-HLS caller bypassed
  // playback-info entirely.
  if (!videoVariant) {
    throw new Error(
      `buildFfmpegArgs: missing videoVariant for profile "${profile.name}" — caller must thread it from the LiveSession`,
    );
  }
  const variant: CodecVariant = videoVariant;
  const isHdrOutput = variant.hdr !== null;
  // Dolby Vision P5 tonemaps through the RPU-aware libplacebo (Vulkan) chain,
  // on CPU decode/encode, only when the boot probe confirmed it works (#636).
  const useDoviTonemap =
    !!tonemap &&
    sourceDvProfile === 5 &&
    (sourceDvBlSignalCompatId === 0 || sourceDvBlSignalCompatId == null) &&
    isLibplaceboDvEnabled();

  // Image-based subtitle burn-in (PGS/VOBSUB) is composited via -filter_complex
  // below, reusing the encoder's video chain so the accelerated scale/tonemap
  // is preserved (the overlay is grafted onto it, no CPU forcing).
  const imageBurnIn = burnIn?.type === 'image' && burnIn.streamIndex != null;

  // Resolve the encode pipeline once via the shared resolver that stream-builder
  // also uses (so the stats hwAccel can't drift from the encoder that runs):
  // the requested-vs-effective hwAccel, the encoder (with registry CPU
  // fallback), the tone-map path, and the QSV-native eligibility.
  const {
    requestedHwAccel,
    encoder,
    effectiveHwAccel,
    tonemapPath,
    qsvNativeAvailable,
    useVaapiTonemap,
    amfFullGpuAvailable,
  } = resolveEncodePipeline(variant, {
    hwAccel: useDoviTonemap ? 'none' : hwAccel,
    crop: !!crop,
    burnIn: !!burnIn?.filter,
    tonemap: !!tonemap,
    tonemapAlgo,
    sourceVideoCodec,
  });
  // No encoder means the variant is unsupported on this host even after the
  // registry's CPU fallback.
  if (!encoder) {
    throw new Error(
      `No encoder for variant ${JSON.stringify(variant)} on ${requestedHwAccel}`,
    );
  }

  // NVENC and AMF have no on-encoder HDR→SDR tone-map, so it runs off-encoder.
  // When the OpenCL tone-map probe passed, route it through tonemap_opencl
  // (GPU) instead of the CPU zscale chain — decisive on 4K where the CPU
  // tone-map can't sustain real-time, and it offloads the (often weak) APU CPU.
  const openclTonemap =
    !!tonemap &&
    (effectiveHwAccel === 'nvenc' || effectiveHwAccel === 'amf') &&
    isOpenclTonemapEnabled();
  // GPU decode whenever available, including the tone-map path — the frame
  // reaches OpenCL via hwdownload→hwupload (a copy, no CUDA/D3D11↔OpenCL interop).
  const decodeHwAccel: HwAccelType = effectiveHwAccel;

  // Early sessions live ~1s before Shaka jumps to the main session — visual
  // quality on those warm-up frames is throwaway, so bias every knob towards
  // ramp-up speed. `veryfast` everywhere keeps the H.264 profile consistent
  // with the steady-state session (`faster` → High); the libx264 `ultrafast`
  // preset implies `--no-cabac` which downgrades the bitstream to Constrained
  // Baseline and produces an SPS that doesn't match the High SPS in the
  // main session's init.mp4 — player concatenates the two and corrupts.
  const earlyPreset = early ? 'veryfast' : encoderPreset;
  // NVENC preset is held identical across the early and steady-state
  // sessions, for the same reason the libx264 preset is pinned above: NVENC
  // bakes preset-dependent knobs (num_ref_frames, level, VUI) into the SPS,
  // and the controller can serve init.mp4 from one session while serving
  // segments from the other. A p1/p4 split shipped an init (p1) whose SPS
  // didn't match the p4-encoded slices — fatal under hvc1 (parameter sets
  // live only in the init), producing macroblock corruption from seg-0.
  // NVENC encodes 1080p at >10x realtime even at p4, so pinning the warm-up
  // session to p4 costs no meaningful first-segment latency.
  const nvencPreset = 'p4';
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

  // Resolve the decoder via the same registry pattern as the encoder.
  // The decoder picks how the source is brought into memory (HW device
  // init + `-hwaccel`); the encoder's `hwAccel` + `inputSurface` decide
  // where the frame needs to land for encode (qsv-native + vpp_qsv,
  // vaapi + scale_vaapi, CPU + hwdownload). `useVaapiTonemap` /
  // `tonemapPath` / `qsvNativeAvailable` come from resolveEncodePipeline above.
  const normalisedSourceCodec = normaliseSourceCodec(sourceVideoCodec);
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
      : amfFullGpuAvailable &&
          effectiveHwAccel === 'amf' &&
          normalisedSourceCodec
        ? // Full-GPU AMF: D3D11-native decode so scale_d3d11 + AMF stay on the
          // device with no CPU round-trip.
          findAmfNativeDecoder(normalisedSourceCodec)
        : decoderRegistry.resolve(
            {
              codec: normalisedSourceCodec ?? 'h264',
              bitDepth: sourceBitDepth,
            },
            decodeHwAccel,
          );
  args.push(...decoder.buildInputArgs());

  // Full-Metal HDR opt-in. The h264/hevc_videotoolbox encoders can keep
  // the pipeline on IOSurface end-to-end when the only filter step is
  // an HDR→SDR tonemap (no burn-in, no crop): `scale_vt` accepts
  // videotoolbox_vld buffers and emits the same surface format the
  // encoder ingests. The default VT decoder descriptor outputs CPU
  // buffers (every other consumer expects them), so we override its
  // input args here when the Metal fast path is eligible. The encoder
  // branches on `inputSurface === 'videotoolbox'` to pick the scale_vt
  // filter; falls back to the CPU tonemap chain otherwise.
  const useVtMetalPath =
    decoder.hwAccel === 'videotoolbox' &&
    (encoder.id === 'h264_videotoolbox' || encoder.id === 'hevc_videotoolbox') &&
    tonemap &&
    !burnIn?.filter &&
    !crop;
  if (useVtMetalPath) {
    args.push('-hwaccel_output_format', 'videotoolbox_vld');
  }

  // OpenCL device init for the tonemap_opencl filter chain. Only needed
  // when (a) we're tonemapping HDR→SDR AND (b) the VAAPI in-place
  // tonemap fallback isn't active AND (c) the decoder's output sits on
  // VAAPI surfaces — the only path that uses the opencl bridge today.
  //
  // Critical: do NOT override `-filter_hw_device` here. The decoder
  // already set it to the vaapi (or qsv) device, and that's what the
  // `hwupload=derive_device=vaapi` step in `hwCropPrefix` needs to
  // resolve correctly. Setting `-filter_hw_device ocl` would re-route
  // every device-less filter through opencl, and Intel iHD reports
  // `Query format failed: Function not implemented` (ENOSYS) when
  // hwupload tries to materialise a vaapi context from an opencl
  // default — the visible failure for cropped HDR sessions was
  // `Parsed_hwupload_3: Query format failed` followed by exit=218.
  // `tonemap_opencl` doesn't need to be the default device: it picks
  // its device from the upstream `hwmap=derive_device=opencl` frame
  // context, and the round-trip back to qsv uses an explicit
  // `derive_device=qsv` on the closing hwmap.
  // `!openclTonemap`: that path inits `ocl` below — skip here to avoid a
  // duplicate `-init_hw_device` alias when a vaapi decoder feeds an AMF/NVENC encode.
  if (
    tonemap &&
    !useVaapiTonemap &&
    decoder.outputSurface === 'vaapi' &&
    !openclTonemap
  ) {
    args.push('-init_hw_device', 'opencl=ocl:0.0');
  }
  // NVENC/AMF OpenCL tone-map: OpenCL as the default filter device so `hwupload`
  // lands on it, coexisting with the HW decode device (validated by the probe).
  if (openclTonemap) {
    args.push(...openclTonemapInitArgs());
  }
  // Windows QSV OpenCL tone-map (zero-copy): the frame maps D3D11→OpenCL and
  // back to QSV, so OpenCL must be the default filter device AND derived from
  // the same D3D11 device (`opencl=ocl@dx`) to share surfaces. ffmpeg accepts
  // only one filter device, so repoint the decoder's `-filter_hw_device qs` to
  // `ocl` and add the derived OpenCL device just before it.
  const qsvOpenclTonemap =
    !!tonemap &&
    tonemapPath === 'opencl' &&
    effectiveHwAccel === 'qsv' &&
    decoder.outputSurface === 'd3d11';
  if (qsvOpenclTonemap) {
    const fhd = args.lastIndexOf('-filter_hw_device');
    if (fhd !== -1) {
      args[fhd + 1] = 'ocl';
      args.splice(fhd, 0, '-init_hw_device', 'opencl=ocl@dx');
    }
  }
  if (useDoviTonemap) {
    args.push('-init_hw_device', 'vulkan=vk:0', '-filter_hw_device', 'vk');
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

  const tonemapCurve = resolveTonemapCurve();
  const encoderInput: EncoderInput = {
    variant,
    target: {
      width: w,
      height: h,
      videoBitrateBps: bitrateNum,
      gopSize,
      frameRate: fps,
    },
    preset: earlyPreset,
    nvencPreset,
    seekSeconds,
    early,
    forceKeyframesExpr,
    qsv: {
      extra: qsvExtra,
      rcInitOccupancy: qsvRcInitOccupancy,
      bufsize: qsvBufsize,
    },
    libx264BufsizeMb,
    filters: buildVideoFilters({
      crop,
      burnIn,
      tonemap,
      useVaapiTonemap,
      sourceBitDepth,
      dovi: useDoviTonemap,
      tonemapCurve,
      scaleWidth: w,
      openclTonemap,
    }),
    tonemap,
    tonemapPath,
    tonemapCurve,
    hasBurnIn: !!burnIn?.filter,
    hasCrop: !!crop,
    hdrMetadata: sourceHdrMetadata,
    // Override to 'videotoolbox' when the Metal fast path is active —
    // the descriptor's static `outputSurface` is `'cpu'` because every
    // OTHER VT consumer expects CPU buffers, but we just told the
    // decoder (via `-hwaccel_output_format videotoolbox_vld`) to emit
    // IOSurfaces in this particular session. The encoder branches on
    // this to pick scale_vt vs the CPU tonemap chain.
    inputSurface: useVtMetalPath ? 'videotoolbox' : decoder.outputSurface,
  };
  args.push(...encoder.buildArgs(encoderInput));

  // Bitmap subtitle burn-in: lift the encoder's `-vf` (the accelerated
  // scale/tonemap chain) into a `-filter_complex` and graft the subtitle
  // overlay onto it, so the HW pipeline (and HDR tone-map) is preserved. The
  // output is mapped from `[vout]` below.
  if (imageBurnIn) {
    const vfIdx = args.indexOf('-vf');
    const videoFilter = vfIdx !== -1 ? args[vfIdx + 1] : '';
    if (vfIdx !== -1) args.splice(vfIdx, 2);
    args.push(
      '-filter_complex',
      buildImageBurnInFilterComplex({
        hwAccel: effectiveHwAccel,
        videoFilter,
        streamIndex: burnIn!.streamIndex!,
        width: w,
        height: h,
        bitDepth: variant.bitDepth,
        crop,
      }),
    );
  }
  const videoMapSpec = imageBurnIn ? '[vout]' : '0:v:0';

  // Force BT.709 limited-range SPS VUI on every SDR output.
  //
  // Two failure modes this prevents:
  //
  // 1. HDR → SDR tonemap: h264_qsv (and a few other paths) carry the
  //    source's BT.2020/PQ tags through from AVFrame metadata into the
  //    output SPS, producing a bitstream that signals HDR with SDR
  //    pixels. iOS AVPlayer rejects that combination with -12927; other
  //    players tolerate it but render with the wrong gamut / TRC.
  //
  // 2. Source with unsignalled colorimetry (older WEBDL H.264
  //    masters): the source SPS leaves
  //    color_primaries/_trc/_space/_range all `unknown`. FFmpeg
  //    propagates the unknown tags into the output SPS. Android
  //    Media3 + the HDR-preserving SurfaceView path can refuse to
  //    initialise MediaCodec on cold prepare when the VUI is fully
  //    unsigned — playback stalls in BUFFERING with no decoder
  //    allocated. A manual seek bypasses the strict initial
  //    validation, which is why the seek "unsticks" the player.
  //
  // No-op when the source already carries BT.709 tags (ffmpeg accepts
  // the redundant overrides). HDR output paths skip this so the
  // encoder keeps the BT.2020/PQ signalling.
  //
  // Also skipped on the VT Metal fast path. `scale_vt=color_matrix=
  // bt709:color_primaries=bt709:color_transfer=bt709` already converts
  // the IOSurface metadata, and adding the output-level `-color_*`
  // flags re-triggers FFmpeg's negotiation to insert a CPU
  // `auto_scale` between the decoder and scale_vt, which then fails
  // with "Failed to find pixel format" (-78 ENOSYS) because no filter
  // bridges CPU pixels back into a videotoolbox_vld IOSurface.
  if (!isHdrOutput && !useVtMetalPath) {
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
  // Use var_stream_map whenever the caller asked for the EXT-X-MEDIA
  // layout (`videoOnly + audioStreams[]`), even for a SINGLE audio
  // track. Multi-audio was the original driver (Shaka switches
  // client-side via EXT-X-MEDIA without a backend reload), but Samsung
  // Tizen AVPlay's HLS-fMP4 parser ALSO requires the same shape on
  // single-audio sources — Tizen muxed-fMP4 stalls silently
  // (issue #148). The controller forces `videoOnly=true` even with
  // 1 audio on fMP4 to trigger this branch.
  const userPickedAudio = audioStreamIndex != null && audioStreamIndex > 0;
  const useVarStreamMap =
    !!audioStreams && varStreamMapLayout(videoOnly, audioStreams.length);

  if (useVarStreamMap) {
    // Single FFmpeg process for video + all audio renditions (perfect sync).
    if (!args.some((a) => a === '-map')) {
      args.push('-map', videoMapSpec);
    }
    for (let i = 0; i < audioStreams.length; i++) {
      args.push('-map', audioMapSpec(audioStreams, i));
    }
    // Per-rendition audio (uniform output codec; copy or transcode per track).
    // Falls back to the single `audioArgs` only when no plans were threaded.
    const perStream = perStreamAudioArgs(
      audioStreams,
      audioTrackPlans,
      profile.audioBitrate,
    );
    args.push(...(perStream ?? audioArgs));

    // Build var_stream_map: "v:0,agroup:audio a:0,agroup:audio,language:fre ..."
    const varParts = ['v:0,agroup:audio'];
    for (let i = 0; i < audioStreams.length; i++) {
      const lang = audioStreams[i].language || 'und';
      varParts.push(`a:${i},agroup:audio,language:${lang}`);
    }

    args.push(
      ...(useTs ? [] : ['-movflags', '+cmaf']),
      '-f',
      'hls',
      // Cut on the fps-aware grid (== the forced-IDR cadence and the playlist
      // EXTINF), not the integer setting. On fractional-fps sources the audio
      // renditions would otherwise be cut on the 3.0s grid while video IDRs land
      // on 3.003s; the per-segment drift accumulates until the tfdt anchor snaps
      // audio a whole segment late mid-film (sudden A/V desync).
      '-hls_time',
      String(realSeg),
      '-hls_list_size',
      '0',
      '-start_number',
      String(startSegment),
      '-hls_segment_type',
      segType,
      ...(useTs ? [] : ['-hls_fmp4_init_filename', 'init_%v.mp4']),
      '-hls_flags',
      'independent_segments+temp_file',
      '-var_stream_map',
      varParts.join(' '),
      '-hls_segment_filename',
      ffOutPath(outputDir, '%v', `seg-%04d.${segExt}`),
      ffOutPath(outputDir, '%v', 'index.m3u8'),
    );
  } else {
    // Standard single-stream output: video + one audio track muxed.
    // When the user picked a track from the UI honour it; otherwise default
    // to the first audio. Explicit -map skips ffmpeg's auto-pick of a
    // subtitle stream — mandatory on sources with many subtitle tracks
    // (some HEVC MKVs have 28+) where the parallel subrip→webvtt pipeline
    // starves the VAAPI HEVC decoder buffer pool, making the early session
    // loop on "thread_get_buffer() failed".
    // Audio-less sources (silent video, corrupted track, etc.) must NOT
    // emit a `-map` for audio — FFmpeg fails with "Stream map matches no
    // streams" otherwise.
    if (hasNoAudio(audioStreams)) {
      args.push('-map', videoMapSpec, '-an');
    } else {
      const pickedRel = userPickedAudio ? audioStreamIndex! : 0;
      args.push(
        '-map',
        videoMapSpec,
        '-map',
        audioMapSpec(audioStreams, pickedRel),
      );
      args.push(...audioArgs);
    }

    args.push(
      ...(useTs ? [] : ['-movflags', '+cmaf']),
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
      ffOutPath(outputDir, `seg-%04d.${segExt}`),
      '-hls_flags',
      'independent_segments+temp_file',
      ffOutPath(outputDir, 'index.m3u8'),
    );
  }

  return args;
}

export interface BuildAudioOnlyArgsOptions {
  inputPath: string;
  outputDir: string;
  audioStreamIndex: number;
  audioBitrate?: string;
  startSegment?: number;
  trustedStreamInfo?: boolean;
  useTs?: boolean;
  /** Cached streamInfo audio array. Used to resolve `audioStreamIndex`
   *  (relative) to its absolute ffprobe index so `-map 0:<abs>` skips
   *  FFmpeg's audio enumeration. */
  audioStreams?: AudioStreamMeta[];
  /** Source fps, so the resume seek lands on the same fps-aware grid as video. */
  sourceFps?: number;
}

/**
 * Build FFmpeg args for audio-only HLS output (used for multi-audio EXT-X-MEDIA renditions).
 * Lightweight: no video encoding, no HW accel needed.
 */
export function buildAudioOnlyFfmpegArgs(
  opts: BuildAudioOnlyArgsOptions,
  log: Logger,
): string[] {
  const {
    inputPath,
    outputDir,
    audioStreamIndex,
    audioBitrate = '192k',
    startSegment = 0,
    trustedStreamInfo = false,
    useTs = false,
    audioStreams,
    sourceFps,
  } = opts;
  const segType = useTs ? 'mpegts' : 'fmp4';
  const segExt = useTs ? 'ts' : 'm4s';
  // fps-aware segment length so audio renditions cut on the same grid as the
  // video IDRs / playlist EXTINF (see buildFfmpegArgs). Equals the integer
  // setting for integer / unknown fps.
  const realSeg = realSegmentSeconds(sourceFps);

  const args = ['-hide_banner', '-loglevel', 'warning'];
  if (trustedStreamInfo) {
    log.debug?.(
      'Probe [audio-only]: using cached streamInfo (0s / 5MB ceiling)',
    );
    args.push('-analyzeduration', '0', '-probesize', TRUSTED_PROBE_SIZE);
  } else {
    log.log(
      'Probe [audio-only]: no cached streamInfo — running full FFmpeg scan (1s / 1MB)',
    );
    args.push('-analyzeduration', '1000000', '-probesize', '1000000');
  }

  const seekSeconds =
    startSegment > 0 ? segmentIndexToSeconds(startSegment, sourceFps) : 0;

  if (startSegment > 0) {
    args.push('-ss', String(seekSeconds));
  }

  args.push('-i', inputPath);

  // Preserve source PTS end-to-end on every spawn (see
  // `buildFfmpegArgs` for the full rationale) so audio renditions stay
  // anchored to the same timeline as the main video output.
  args.push('-copyts', '-muxdelay', '0', '-muxpreload', '0');

  args.push('-map', audioMapSpec(audioStreams, audioStreamIndex));
  args.push('-vn');
  args.push('-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2');

  args.push(
    ...(useTs ? [] : ['-movflags', '+cmaf']),
    '-f',
    'hls',
    '-hls_time',
    String(realSeg),
    '-hls_list_size',
    '0',
    '-start_number',
    String(startSegment),
    '-hls_segment_type',
    segType,
    ...(useTs ? [] : ['-hls_fmp4_init_filename', 'init.mp4']),
    '-hls_segment_filename',
    ffOutPath(outputDir, `seg-%04d.${segExt}`),
    '-hls_flags',
    'independent_segments+temp_file',
    ffOutPath(outputDir, 'index.m3u8'),
  );

  return args;
}

/**
 * Build FFmpeg args for remux mode: copy video stream, optionally transcode audio.
 * This is much cheaper than full transcoding — no video re-encoding.
 */
export interface BuildRemuxArgsOptions {
  inputPath: string;
  outputDir: string;
  copyAudio: boolean;
  audioBitrate?: string;
  startSegment?: number;
  videoOnly?: boolean;
  trustedStreamInfo?: boolean;
  audioStreamIndex?: number;
  /** Source video codec (ffprobe `codec_name`, lowercased). Drives the
   *  `-tag:v hvc1` flag for HEVC inputs — FFmpeg's mov muxer otherwise
   *  defaults to `hev1`, which Apple HLS rejects: the spec requires
   *  parameter sets in the moov sample description (`hvc1`), not inline
   *  in the bitstream (`hev1`). Without this, iOS AVPlayer fails the
   *  variant with error -12927 on the first segment fetch. */
  sourceVideoCodec?: string;
  /** Cached streamInfo audio array. See {@link AudioStreamMeta}. */
  audioStreams?: AudioStreamMeta[];
  /** Keyframe-aligned segment start times (`boundaries[i]` = start of seg-`i`).
   *  Copied video is cut at the source keyframes, so a resume/seek must seek to
   *  the real start of `startSegment` — not the uniform-grid `index * segDur`,
   *  which lands on the wrong content and desyncs the post-seek playlist. */
  segmentBoundaries?: number[];
}

export function buildRemuxArgs(
  opts: BuildRemuxArgsOptions,
  log?: Logger,
): string[] {
  const {
    inputPath,
    outputDir,
    copyAudio,
    audioBitrate = '192k',
    startSegment = 0,
    videoOnly = false,
    trustedStreamInfo = false,
    audioStreamIndex,
    sourceVideoCodec,
    audioStreams,
    segmentBoundaries,
  } = opts;
  const SEGMENT_DURATION = getSegmentDuration();

  const args = ['-hide_banner', '-loglevel', 'warning'];
  if (trustedStreamInfo) {
    log?.log('Probe [remux]: using cached streamInfo (0s / 5MB ceiling)');
    args.push('-analyzeduration', '0', '-probesize', TRUSTED_PROBE_SIZE);
  } else {
    log?.log(
      'Probe [remux]: no cached streamInfo — running full FFmpeg scan (1s / 1MB)',
    );
    args.push('-analyzeduration', '1000000', '-probesize', '1000000');
  }

  const remuxSeekSeconds =
    startSegment > 0
      ? (segmentBoundaries?.[startSegment] ??
        segmentIndexToSeconds(startSegment))
      : 0;
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
  if ((videoOnly && !userPickedAudio) || hasNoAudio(audioStreams)) {
    // Video-only remux: var_stream_map (audio served separately) OR a
    // source with zero audio streams in the cached streamInfo.
    args.push('-map', '0:v:0', '-c:v', 'copy', '-an');
  } else if (userPickedAudio) {
    args.push(
      '-map',
      '0:v:0',
      '-map',
      audioMapSpec(audioStreams, audioStreamIndex!),
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
    '-movflags',
    '+cmaf',
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
    'independent_segments+temp_file',
    path.join(outputDir, 'index.m3u8'),
  );

  return args;
}
