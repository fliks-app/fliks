import type { HwAccelType } from '../types';

/** Video codecs supported by the streaming pipeline. Extend this union and
 *  add encoder implementations under `./encoders/` to introduce a new
 *  codec (e.g. `'vvc'`); every other module reads codec capability through
 *  the registry, so no switch statements need editing. */
export type VideoCodec = 'h264' | 'hevc' | 'av1';

export type BitDepth = 8 | 10;

/** HDR transfer / signaling. `null` means SDR.
 *  - HDR10: BT.2020 primaries + SMPTE-ST-2084 (PQ) transfer + static metadata
 *  - HLG:   BT.2020 primaries + ARIB STD-B67 transfer
 *  - DV*:   Dolby Vision profiles; transcode support is intentionally out of
 *           scope (DirectPlay only). Listed for typing completeness. */
export type HdrFormat = 'HDR10' | 'HLG' | 'DV5' | 'DV81' | 'DV84';

/** The triple that uniquely identifies a video output format. Resolution
 *  and bitrate are not part of identity — those live on `LadderRung`. */
export interface CodecVariant {
  codec: VideoCodec;
  bitDepth: BitDepth;
  hdr: HdrFormat | null;
}

/** Minimal source-side info the encoder needs to set up scale filters,
 *  color tags and seek geometry. Populated from ffprobe streamInfo. */
export interface EncoderSourceInfo {
  width: number;
  height: number;
  frameRate?: number;
  hdr: HdrFormat | null;
  /** Source bit depth (driven by sourceVideoCodec + ffprobe `bits_per_raw_sample`). */
  bitDepth: BitDepth;
  /** ffprobe `codec_name` (lowercased). Drives bsf choice and decode path. */
  codecName: string;
}

/** Output target for a single rung — resolution + bitrate + GOP cadence. */
export interface EncoderTarget {
  width: number;
  height: number;
  videoBitrateBps: number;
  /** Number of frames between forced IDRs. Drives `-g`, `-keyint_min` and
   *  `force_key_frames` expression. Computed from source fps × segment
   *  duration so segments stay perfectly uniform. */
  gopSize: number;
  /** Source frame rate (rounded to int for ffmpeg). */
  frameRate: number;
}

/** Per-spawn inputs to an encoder's args builder. Common across encoders. */
export interface EncoderInput {
  source: EncoderSourceInfo;
  variant: CodecVariant;
  target: EncoderTarget;
  /** Encoder preset hint (`veryfast`, `faster`, `fast`, `medium`, `slow`).
   *  Each encoder maps it onto its own preset namespace (NVENC `p1..p7`,
   *  VAAPI ignores presets entirely). The orchestrator passes the
   *  early-session-adjusted preset already — encoders don't second-guess. */
  preset: string;
  /** NVENC-specific preset (`p1..p7`). Orchestrator pre-resolves it
   *  separately because libx264 / x265 / qsv / vt all share the named
   *  preset namespace but NVENC uses numbers. */
  nvencPreset: string;
  /** Mid-file resume position (source seconds). 0 = fresh play. */
  seekSeconds: number;
  /** True for the early-warm shadow session (small `-t 4` window, runs
   *  parallel to the main session to serve seg-0 fast). */
  early: boolean;
  /** `force_key_frames` expression — pre-formatted by the orchestrator
   *  so every encoder anchors IDRs on the same uniform grid. */
  forceKeyframesExpr: string;
  /** QSV-specific rate-control knobs. Other encoders ignore. */
  qsv: {
    /** Encoder flags: `-forced_idr 1 -adaptive_i 0 -bf 0 -b_strategy 0`,
     *  plus `-low_power 1` when enabled in admin settings. */
    extra: string[];
    /** `-rc_init_occupancy` in bits. */
    rcInitOccupancy: number;
    /** `-bufsize` in bits. */
    bufsize: number;
  };
  /** libx264 `-bufsize` in megabits (formatted string, e.g. `"16M"`). */
  libx264BufsizeMb: string;
  /** Filter snippets the encoder may need to splice into its `-vf` chain.
   *  Each is either empty `""` or starts with `,` to chain after a prior
   *  filter (e.g. `cpuCropPrefix` is `"crop=W:H:X:Y,"`). */
  filters: {
    cropStr: string;
    cpuCropPrefix: string;
    hwCropPrefix: string;
    burnInFilter: string;
    tonemapVaapi: string;
    tonemapOpencl: string;
    tonemapCpu: string;
  };
  /** True when the orchestrator is applying an HDR→SDR tonemap pass.
   *  Encoders use this to force BT.709 color tags on the SPS VUI so the
   *  bitstream doesn't carry source HDR tags through with SDR pixels. */
  tonemap: boolean;
  hasBurnIn: boolean;
  hasCrop: boolean;
  /** Surface format on the decoder's output side. Encoders use it to
   *  pick the right scale / crop filter: when a QSV encoder receives
   *  QSV surfaces from a qsv-native decoder it can use `vpp_qsv` for
   *  both crop and scale; when it receives VAAPI surfaces (default
   *  Linux path) it stays on the `scale_vaapi → hwmap=qsv` chain. */
  inputSurface: import('./decoders/types').SurfaceFormat;
}

/** A single encoder binding — one ffmpeg encoder × one platform × one
 *  CodecVariant. Each binding lives in its own file under `./encoders/`.
 *  The registry holds an immutable list of every binding compiled in. */
export interface EncoderDescriptor {
  /** Short identifier for logs / stats overlay (e.g. `'hevc_qsv_main10'`). */
  readonly id: string;
  readonly hwAccel: HwAccelType;
  readonly variant: CodecVariant;
  /** Soft capability check at runtime. Reads `hw-detect.ts` to know if
   *  this binding is usable on the current host (HW present, generation
   *  sufficient, ffmpeg build has the encoder, etc.). */
  supports(): boolean;
  /** True iff this encoder reliably writes HDR static metadata (`mdcv`,
   *  `clli` boxes; SEI messages). When false on an HDR variant, the
   *  registry resolver picks a CPU-fallback descriptor instead. */
  supportsHdrMetadata(): boolean;
  /** Build the ffmpeg argument slice for video encoding only — the input
   *  spec (`-ss`, `-i`, hwaccel init), audio mapping and HLS muxer
   *  options are appended by the orchestrator. */
  buildArgs(input: EncoderInput): string[];
  /** RFC 6381 CODECS attribute for the master playlist's
   *  `EXT-X-STREAM-INF` entry. Driven by `target` because `hvc1.*.LXXX`
   *  encodes the level and the level depends on resolution + fps. */
  codecString(target: EncoderTarget): string;
}

/** Selector / lookup over the registered encoders. */
export interface EncoderRegistry {
  /** Pick the highest-preference descriptor able to produce `variant`
   *  on `hwAccel`. Returns `null` when no descriptor matches — caller
   *  must drop the rung or fall back to a different variant. */
  resolve(
    variant: CodecVariant,
    hwAccel: HwAccelType,
  ): EncoderDescriptor | null;
}
