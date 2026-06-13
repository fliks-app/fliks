import { requestedHwAccelFor } from './hw-detect';
import { encoderRegistry } from './codec/encoders';
import { isDecoderEnabled } from './codec/decoder-probe';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
import {
  isTonemapOpenclEnabled,
  isTonemapOpenclEnabledWithCrop,
} from './codec/tonemap-opencl-probe';
import { resolveTonemapPath } from './tonemap-path';
import { normaliseSourceCodec } from './codec/normalise';
import type { CodecVariant } from './codec/types';
import type { HwAccelType, TonemapAlgo } from './types';

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
  /** QSV can perform the crop (native, or via the vaapi-decode splice). */
  qsvCanCrop: boolean;
  /** tonemap_vaapi is the chosen tonemap step (the filter helpers' flag). */
  useVaapiTonemap: boolean;
}

/**
 * Resolve the encode pipeline for a frozen output variant on this host: the
 * requested vs effective hwAccel, the encoder descriptor (with registry CPU
 * fallback), the tone-map path, and the QSV-native eligibility. Single source of
 * truth shared by the segment builder (ffmpeg-args, which then drives the argv +
 * decoder) and the playback decision (stream-builder, which reports the
 * effective hwAccel in the stats) so the reported encoder can't drift from the
 * one that actually runs. Pure: depends only on the inputs + the boot-time
 * encoder/decoder/tonemap probe state (stable between playback-info and spawn).
 */
export function resolveEncodePipeline(
  variant: CodecVariant,
  ctx: EncodePipelineContext,
): ResolvedEncodePipeline {
  const normalisedSourceCodec = normaliseSourceCodec(ctx.sourceVideoCodec);
  const hasUsableQsvNativeDecoder =
    ctx.hwAccel === 'qsv' &&
    !ctx.burnIn &&
    normalisedSourceCodec != null &&
    isDecoderEnabled(`${normalisedSourceCodec}_qsv_native_decode`);
  // `auto` picks opencl when the boot probe enabled it, vaapi otherwise; the
  // explicit overrides bypass the probe. Drives both the qsv-native gate and
  // the useVaapiTonemap flag so the two stay in sync.
  const tonemapPath = resolveTonemapPath(ctx.tonemapAlgo, {
    hasCrop: ctx.crop,
  });
  const tonemapOpenclOk = ctx.crop
    ? isTonemapOpenclEnabledWithCrop()
    : isTonemapOpenclEnabled();
  // Keep the whole pipeline on QSV (no hwdownload→crop→hwupload round-trip):
  // crop-only always; tonemap via vpp_qsv LUT or via opencl when probed;
  // tonemap via vaapi is NOT qsv-native compatible.
  const qsvNativeAvailable =
    hasUsableQsvNativeDecoder &&
    (ctx.crop || tonemapPath === 'qsv' || tonemapPath === 'opencl') &&
    (!ctx.tonemap ||
      (tonemapPath === 'qsv' && isVppQsvTonemapEnabled()) ||
      (tonemapPath === 'opencl' && tonemapOpenclOk));
  const qsvCanCrop =
    qsvNativeAvailable ||
    (ctx.hwAccel === 'qsv' && ctx.crop && ctx.tonemap && !ctx.burnIn);

  const requestedHwAccel = requestedHwAccelFor(ctx.hwAccel, {
    burnIn: ctx.burnIn,
    crop: ctx.crop,
    qsvCanCrop,
  });
  const encoder = encoderRegistry.resolve(variant, requestedHwAccel);
  const effectiveHwAccel: HwAccelType = encoder?.hwAccel ?? 'none';
  const useVaapiTonemap = ctx.tonemap && tonemapPath === 'vaapi';

  return {
    requestedHwAccel,
    encoder,
    effectiveHwAccel,
    tonemapPath,
    qsvNativeAvailable,
    qsvCanCrop,
    useVaapiTonemap,
  };
}
