import { Logger } from '@nestjs/common';
import { requestedHwAccelFor } from './hw-detect';
import { hostHasVaapi } from './hw-device';
import { encoderRegistry } from './codec/encoders';
import { isDecoderEnabled } from './codec/decoder-probe';
import { decoderRegistry, findQsvNativeDecoder, findAmfNativeDecoder } from './codec/decoders';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
import { isAmfOpenclEnabled } from './codec/amf-opencl-probe';
import { isOpenclTonemapEnabled } from './codec/opencl-tonemap-probe';
import { isCudaTonemapEnabled } from './codec/cuda-tonemap-probe';
import { openclBridgeOk, resolveTonemapPath } from './tonemap-path';
import { normaliseSourceCodec } from './codec/normalise';
import { dvHasNoBase } from './codec/dolby-vision';
import type { BitDepth, CodecVariant, TonemapCurve } from './codec/types';
import type { HwAccelType, TonemapAlgo } from './types';

const logger = new Logger('EncodePipeline');

// Resolved on every playback-info and spawn: log the misconfiguration once.
let qsvTonemapFallbackWarned = false;
function warnQsvTonemapFallbackOnce(toVaapi: boolean): void {
  if (qsvTonemapFallbackWarned) return;
  qsvTonemapFallbackWarned = true;
  logger.warn(
    `tonemapAlgo=qsv: no vpp_qsv tonemap for this session (LUT probe, burn-in or decoder); using ${toVaapi ? 'tonemap_vaapi' : 'a CPU encode'}`,
  );
}

/** NVENC's zero-copy HDR→SDR path, shared by `ffmpeg-args` and the
 *  playback-info controller so the argv and the stats label can't drift. */
export function isCudaTonemapPath(tonemap: boolean, hwAccel: string): boolean {
  return tonemap && hwAccel === 'nvenc' && isCudaTonemapEnabled();
}

/** NVENC/AMF's off-encoder tonemap (falls back from `tonemap_cuda`, see
 *  {@link isCudaTonemapPath}); a no-base DV source needs the same RPU-aware bounce. */
export function isOpenclTonemapPath(
  tonemap: boolean,
  hwAccel: string,
  dvNoBase: boolean,
): boolean {
  return (
    tonemap &&
    !isCudaTonemapPath(tonemap, hwAccel) &&
    isOpenclTonemapEnabled() &&
    (hwAccel === 'nvenc' || hwAccel === 'amf' || dvNoBase)
  );
}

/** Shared eligibility check for the tonemap and HDR-passthrough Metal paths below. */
function vtSurfaceDecodable(sourceVideoCodec: string | undefined): boolean {
  const codec = normaliseSourceCodec(sourceVideoCodec);
  return (
    codec != null &&
    decoderRegistry.resolve({ codec, bitDepth: 10 }, 'videotoolbox').hwAccel ===
      'videotoolbox'
  );
}

/** True when the session tone-maps on VideoToolbox's Metal surface
 *  (RPU-aware `apply_dovi`); burn-in forces CPU. Shared with ffmpeg-args. */
export function isVtTonemapPath(
  tonemap: boolean,
  hwAccel: string,
  burnIn: boolean,
  sourceVideoCodec: string | undefined,
): boolean {
  return (
    tonemap &&
    hwAccel === 'videotoolbox' &&
    !burnIn &&
    vtSurfaceDecodable(sourceVideoCodec)
  );
}

/** HDR10/HLG passthrough on VT Metal: `scale_vt` keeps the p010 IOSurface
 *  end-to-end instead of a CPU scale. Same as the tonemap path, minus `tonemap`. */
export function isVtHdrPassthroughPath(
  isHdrOutput: boolean,
  hwAccel: string,
  burnIn: boolean,
  hasCrop: boolean,
  sourceVideoCodec: string | undefined,
): boolean {
  return (
    isHdrOutput &&
    hwAccel === 'videotoolbox' &&
    !burnIn &&
    !hasCrop &&
    vtSurfaceDecodable(sourceVideoCodec)
  );
}

export interface EncodePipelineContext {
  /** Host-detected hwAccel (qsv / vaapi / nvenc / videotoolbox / none). */
  hwAccel: HwAccelType;
  /** Whether the session crops (letterbox removal / scope). */
  crop: boolean;
  /** Whether subtitle burn-in is active (forces CPU surfaces for libass). */
  burnIn: boolean;
  /** Whether the session tone-maps HDR → SDR. */
  tonemap: boolean;
  tonemapAlgo: TonemapAlgo;
  sourceVideoCodec: string | undefined;
  /** Source has no HDR10/HLG base to fall back to (P5, or P10 with an
   *  unknown/0 compat id): see {@link dvHasNoBase}. */
  dvNoBase: boolean;
  /** Source bit depth: gates the AMF native decoder (e.g. H.264 Hi10P
   *  exceeds its 8-bit max) against a real source, not just its codec. */
  sourceBitDepth: BitDepth;
}

export interface ResolvedEncodePipeline {
  /** The hwAccel the registry was asked for (QSV may downshift to VAAPI for a
   *  cropped tonemap chain — see requestedHwAccelFor). */
  requestedHwAccel: HwAccelType;
  /** The resolved encoder descriptor, or undefined when none is available. */
  encoder: ReturnType<typeof encoderRegistry.resolve>;
  /** The hwAccel the encoder actually runs on (after registry CPU fallback). */
  effectiveHwAccel: HwAccelType;
  tonemapPath: ReturnType<typeof resolveTonemapPath>;
  /** Whole pipeline stays on the QSV device (qsv-native decode + vpp_qsv). */
  qsvNativeAvailable: boolean;
  /** `qsvNativeAvailable` narrowed to sessions that actually land on the QSV
   *  encoder — the routing flag `qsv-filters.ts` and the decode stage read to
   *  pick the native vpp_qsv chain over the VAAPI-derived one. */
  qsvNative: boolean;
  /** QSV can perform the crop (native, or via the vaapi-decode splice). */
  qsvCanCrop: boolean;
  /** tonemap_vaapi is the chosen tonemap step (the filter helpers' flag). */
  useVaapiTonemap: boolean;
  /** Whole pipeline stays on the D3D11 device (d3d11 decode + OpenCL
   *  scale/tonemap + AMF encode, zero-copy). Covers SDR and HDR, cropped or not. */
  amfOpenclAvailable: boolean;
}

/** Resolve the encode pipeline for a frozen output variant on this host. Pure
 *  and shared by ffmpeg-args (argv) and stream-builder (stats) so neither can
 *  report an encoder that doesn't match what the other actually runs. */
export function resolveEncodePipeline(
  variant: CodecVariant,
  ctx: EncodePipelineContext,
  platform: NodeJS.Platform = process.platform,
): ResolvedEncodePipeline {
  const noVaapi = !hostHasVaapi(platform);
  const normalisedSourceCodec = normaliseSourceCodec(ctx.sourceVideoCodec);
  // The QSV encode-path decoder is platform-specific (qsv-native on Linux,
  // d3d11va→qsv on Windows); resolve it by platform rather than a hard-coded id
  // so the gate can't drift from the descriptor the segment builder picks.
  const qsvNativeDecoder =
    normalisedSourceCodec != null
      ? findQsvNativeDecoder(normalisedSourceCodec, platform)
      : null;
  const hasUsableQsvNativeDecoder =
    ctx.hwAccel === 'qsv' &&
    !ctx.burnIn &&
    qsvNativeDecoder != null &&
    isDecoderEnabled(qsvNativeDecoder.id);
  // Zero-copy AMF OpenCL: d3d11 decode → scale_opencl/tonemap_opencl → AMF
  // encode. maxBitDepth catches a source over the codec's usual depth (Hi10P).
  const amfDecoder =
    normalisedSourceCodec != null ? findAmfNativeDecoder(normalisedSourceCodec) : null;
  const amfOpenclAvailable =
    ctx.hwAccel === 'amf' &&
    isAmfOpenclEnabled() &&
    amfDecoder != null &&
    ctx.sourceBitDepth <= amfDecoder.maxBitDepth &&
    isDecoderEnabled(amfDecoder.id);
  // `auto` picks opencl when the boot probe enabled it, vaapi otherwise; the
  // explicit overrides bypass the probe. Drives both the qsv-native gate and
  // the useVaapiTonemap flag so the two stay in sync.
  const tonemapPath = resolveTonemapPath(
    ctx.tonemapAlgo,
    { hasCrop: ctx.crop, dvNoBase: ctx.dvNoBase },
    platform,
  );
  const tonemapOpenclOk = openclBridgeOk(ctx.crop, platform);
  // A no-base DV source has no RPU-aware vaapi/qsv tonemap: when neither GPU
  // bridge is actually usable, keep the pipeline off HW. Vulkan needs a VAAPI
  // encoder and no burn-in; `resolveTonemapPath` doesn't know either.
  const vulkanUsable =
    tonemapPath === 'vulkan' &&
    ctx.tonemap &&
    !ctx.burnIn &&
    ctx.hwAccel === 'vaapi';
  const dvNoBaseNeedsCpu =
    ctx.dvNoBase && ctx.tonemap && tonemapPath !== 'opencl' && !vulkanUsable;
  // Keep the whole pipeline on QSV (no hwdownload→crop→hwupload round-trip):
  // crop-only always; tonemap via vpp_qsv LUT or via opencl when probed;
  // tonemap via vaapi is NOT qsv-native compatible.
  // Without VAAPI (Windows) the qsv-native pipeline is the only QSV path, so
  // it's used for every session (not just crop/tonemap as on Linux).
  const qsvNativeAvailable =
    !dvNoBaseNeedsCpu &&
    hasUsableQsvNativeDecoder &&
    (noVaapi ||
      ctx.crop ||
      tonemapPath === 'qsv' ||
      tonemapPath === 'opencl') &&
    (!ctx.tonemap ||
      (tonemapPath === 'qsv' && isVppQsvTonemapEnabled()) ||
      (tonemapPath === 'opencl' && tonemapOpenclOk));
  const qsvCanCrop =
    qsvNativeAvailable ||
    (ctx.hwAccel === 'qsv' && ctx.crop && ctx.tonemap && !ctx.burnIn);

  let requestedHwAccel = requestedHwAccelFor(
    ctx.hwAccel,
    { burnIn: ctx.burnIn, crop: ctx.crop, qsvCanCrop },
    platform,
  );
  // Without a VAAPI fallback (Windows), QSV without a viable native pipeline
  // (e.g. HDR tonemap with no vpp_qsv/opencl) has no fallback chain — drop to
  // CPU encode.
  // Vulkan tonemap has no burn-in bounce (libplacebo owns the whole surface).
  if (
    (noVaapi && ctx.hwAccel === 'qsv' && !qsvNativeAvailable) ||
    (dvNoBaseNeedsCpu && (ctx.hwAccel === 'qsv' || ctx.hwAccel === 'vaapi')) ||
    (ctx.tonemap && tonemapPath === 'vulkan' && ctx.burnIn)
  ) {
    requestedHwAccel = 'none';
  }
  const encoder = encoderRegistry.resolve(variant, requestedHwAccel);
  const effectiveHwAccel: HwAccelType = encoder?.hwAccel ?? 'none';
  const qsvNative = qsvNativeAvailable && effectiveHwAccel === 'qsv';
  // tonemapAlgo='qsv' without the vpp_qsv LUT has no qsv step of its own: run
  // the same tonemap_vaapi chain as 'vaapi' rather than the unprobed OpenCL one.
  const qsvTonemapFallsBackToVaapi =
    ctx.tonemap && tonemapPath === 'qsv' && !qsvNativeAvailable && !noVaapi;
  if (ctx.tonemap && tonemapPath === 'qsv' && !qsvNativeAvailable && ctx.hwAccel === 'qsv') {
    warnQsvTonemapFallbackOnce(qsvTonemapFallsBackToVaapi);
  }
  // AMF tonemaps HDR->SDR on CPU (no VAAPI to host the tonemap), so it needs
  // the CPU tonemap chain populated — never the vaapi in-place path.
  const useVaapiTonemap =
    !dvNoBaseNeedsCpu &&
    ctx.tonemap &&
    effectiveHwAccel !== 'amf' &&
    (tonemapPath === 'vaapi' || qsvTonemapFallsBackToVaapi);

  return {
    requestedHwAccel,
    encoder,
    effectiveHwAccel,
    tonemapPath,
    qsvNativeAvailable,
    qsvNative,
    qsvCanCrop,
    useVaapiTonemap,
    amfOpenclAvailable,
  };
}

/** {@link resolveEncodePipeline}'s context from the session's source facts, so
 *  the stats, the tonemap report and the spawn all resolve the same pipeline. */
export function encodePipelineInputs(src: {
  hwAccel: HwAccelType;
  crop: boolean;
  /** Text burn-in only: an image burn-in composites without leaving the GPU. */
  textBurnIn: boolean;
  tonemap: boolean;
  tonemapAlgo: TonemapAlgo | undefined;
  sourceVideoCodec: string | undefined;
  isSourceHdr: boolean;
  sourceDvProfile: number | null | undefined;
  sourceDvBlSignalCompatId: number | null | undefined;
}): EncodePipelineContext {
  const dvNoBase = dvHasNoBase(
    src.sourceDvProfile ?? undefined,
    src.sourceDvBlSignalCompatId ?? undefined,
  );
  return {
    hwAccel: src.hwAccel,
    crop: src.crop,
    burnIn: src.textBurnIn,
    tonemap: src.tonemap,
    tonemapAlgo: src.tonemapAlgo ?? 'auto',
    sourceVideoCodec: src.sourceVideoCodec,
    dvNoBase,
    sourceBitDepth: src.isSourceHdr || dvNoBase ? 10 : 8,
  };
}

export type TonemapReportPath =
  | 'vaapi'
  | 'qsv'
  | 'opencl'
  | 'vulkan'
  | 'cuda'
  | 'videotoolbox'
  | 'cpu';

/** The tone-map step a resolved pipeline runs: the flags ffmpeg-args builds its
 *  filters from, and the path + curve the stats overlay reports for them. */
export function resolveTonemapReport(
  pipeline: ResolvedEncodePipeline,
  opts: {
    tonemap: boolean;
    dvNoBase: boolean;
    /** Any burn-in: the VT Metal surface can't take either kind. */
    burnIn: boolean;
    sourceVideoCodec: string | undefined;
    /** No-base DV reshaped to HDR10: `apply_dovi` runs no tone curve. */
    hdr10Target: boolean;
    curve: TonemapCurve;
  },
): {
  useVulkanTonemap: boolean;
  cudaTonemap: boolean;
  openclTonemap: boolean;
  path: TonemapReportPath | null;
  curve: TonemapCurve | undefined;
} {
  const hw = pipeline.effectiveHwAccel;
  const useVulkanTonemap = pipeline.tonemapPath === 'vulkan' && hw === 'vaapi';
  const cudaTonemap = isCudaTonemapPath(opts.tonemap, hw);
  const openclTonemap = isOpenclTonemapPath(opts.tonemap, hw, opts.dvNoBase);
  const path: TonemapReportPath | null = !opts.tonemap
    ? null
    : hw === 'qsv' || hw === 'vaapi'
      ? pipeline.useVaapiTonemap
        ? 'vaapi'
        : pipeline.tonemapPath
      : cudaTonemap
        ? 'cuda'
        : openclTonemap || (hw === 'amf' && pipeline.amfOpenclAvailable)
          ? 'opencl'
          : isVtTonemapPath(opts.tonemap, hw, opts.burnIn, opts.sourceVideoCodec)
            ? 'videotoolbox'
            : 'cpu';
  // The vpp_qsv / tonemap_vaapi LUTs and VT's own tonemap ignore the curve.
  const curveApplies =
    !opts.hdr10Target &&
    (path === 'opencl' || path === 'vulkan' || path === 'cpu' || path === 'cuda');
  return {
    useVulkanTonemap,
    cudaTonemap,
    openclTonemap,
    path,
    curve: curveApplies ? opts.curve : undefined,
  };
}
