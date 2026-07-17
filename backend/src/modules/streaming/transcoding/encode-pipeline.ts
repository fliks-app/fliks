import { requestedHwAccelFor } from './hw-detect';
import { hostHasVaapi } from './hw-device';
import { encoderRegistry } from './codec/encoders';
import { isDecoderEnabled } from './codec/decoder-probe';
import { findQsvNativeDecoder } from './codec/decoders';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
import {
  isTonemapOpenclEnabled,
  isTonemapOpenclEnabledWithCrop,
} from './codec/tonemap-opencl-probe';
import { isScaleD3d11Enabled } from './codec/scale-d3d11-probe';
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
  /** Whole pipeline stays on the D3D11 device (d3d11 decode + scale_d3d11 +
   *  AMF encode, zero-copy). Requires the scale_d3d11 filter (FFmpeg ≥ 8.1). */
  amfFullGpuAvailable: boolean;
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
  // Full-GPU AMF: d3d11 decode → scale_d3d11 → AMF encode, zero-copy. Scoped to
  // the clean SDR case (crop needs an off-GPU pass, HDR→SDR uses the CPU/OpenCL
  // tonemap chain). Gated on the d3d11-native decode probe AND the scale_d3d11
  // filter probe (the filter only exists in FFmpeg ≥ 8.1 and some GPUs reject
  // its output texture) so an unavailable filter degrades to the CPU scale
  // instead of crashing every session.
  const amfFullGpuAvailable =
    ctx.hwAccel === 'amf' &&
    !ctx.burnIn &&
    !ctx.crop &&
    !ctx.tonemap &&
    normalisedSourceCodec != null &&
    isDecoderEnabled(`${normalisedSourceCodec}_d3d11va_native_decode`) &&
    isScaleD3d11Enabled();
  // `auto` picks opencl when the boot probe enabled it, vaapi otherwise; the
  // explicit overrides bypass the probe. Drives both the qsv-native gate and
  // the useVaapiTonemap flag so the two stay in sync.
  const tonemapPath = resolveTonemapPath(
    ctx.tonemapAlgo,
    { hasCrop: ctx.crop },
    platform,
  );
  const tonemapOpenclOk = ctx.crop
    ? isTonemapOpenclEnabledWithCrop()
    : isTonemapOpenclEnabled();
  // Keep the whole pipeline on QSV (no hwdownload→crop→hwupload round-trip):
  // crop-only always; tonemap via vpp_qsv LUT or via opencl when probed;
  // tonemap via vaapi is NOT qsv-native compatible.
  // Without VAAPI (Windows) the qsv-native pipeline is the only QSV path, so
  // it's used for every session (not just crop/tonemap as on Linux).
  const qsvNativeAvailable =
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
  if (noVaapi && ctx.hwAccel === 'qsv' && !qsvNativeAvailable) {
    requestedHwAccel = 'none';
  }
  const encoder = encoderRegistry.resolve(variant, requestedHwAccel);
  const effectiveHwAccel: HwAccelType = encoder?.hwAccel ?? 'none';
  // AMF tonemaps HDR->SDR on CPU (no VAAPI to host the tonemap), so it needs
  // the CPU tonemap chain populated — never the vaapi in-place path.
  const useVaapiTonemap =
    ctx.tonemap && tonemapPath === 'vaapi' && effectiveHwAccel !== 'amf';

  return {
    requestedHwAccel,
    encoder,
    effectiveHwAccel,
    tonemapPath,
    qsvNativeAvailable,
    qsvCanCrop,
    useVaapiTonemap,
    amfFullGpuAvailable,
  };
}
