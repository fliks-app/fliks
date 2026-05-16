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
   *  Each encoder maps it onto its own preset namespace. */
  preset: string;
  /** Mid-file resume position (source seconds). Encoders may use it to
   *  derive `force_key_frames` offsets. 0 = fresh play. */
  seekSeconds: number;
  /** True for the early-warm shadow session (small `-t 4` window, runs
   *  parallel to the main session to serve seg-0 fast). */
  early: boolean;
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
  resolve(variant: CodecVariant, hwAccel: HwAccelType): EncoderDescriptor | null;
  /** Every descriptor that can produce `variant`, ordered by preference
   *  (HW first, CPU fallback last). Used by the runtime fallback path
   *  when a HW encoder fails at session-spawn time. */
  candidates(variant: CodecVariant, hwAccel: HwAccelType): EncoderDescriptor[];
}
