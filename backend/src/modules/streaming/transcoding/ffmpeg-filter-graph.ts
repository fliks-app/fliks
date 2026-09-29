import type { BurnInSubtitle } from './types';
import {
  DEFAULT_TONEMAP_CURVE,
  type EncoderInput,
  type TonemapCurve,
} from './codec/types';

/** The bare zscale/tonemap chain doesn't drop HDR10 static metadata side data,
 *  leaking a Mastering display SEI into SDR output (verified; tonemapx and GPU tonemaps don't leak). */
const HDR_STATIC_SIDEDATA_DELETE =
  'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL,sidedata=mode=delete:type=DYNAMIC_HDR_PLUS';

/** `tonemap_opencl` (and `tonemap_videotoolbox`) RPU-reshaping option. The
 *  bundled ffmpeg defaults it to 1; only a source that `dvAppliesRpu` needs it
 *  applied, so every other source (including PQ-base P7/P8.1) must pass 0
 *  explicitly. */
export function dvApplyDoviOpt(applyRpu: boolean | undefined): string {
  return `apply_dovi=${applyRpu ? 1 : 0}`;
}

/** Shared `tonemap_opencl`/`tonemap_cuda` option string — same option surface
 *  on both filters. HDR10 target: reshape to PQ/BT.2020, no tone curve. */
export function tonemapOpenclOpts(opts: {
  hdr10Target?: boolean;
  curve: TonemapCurve;
  applyRpu?: boolean;
}): string {
  const { hdr10Target, curve, applyRpu } = opts;
  return hdr10Target
    ? `format=p010:t=smpte2084:p=bt2020:m=bt2020:r=tv:${dvApplyDoviOpt(applyRpu)}`
    : `format=nv12:p=bt709:t=bt709:m=bt709:tonemap=${curve}:desat=0:${dvApplyDoviOpt(applyRpu)}`;
}

export interface VideoFilterContext {
  crop?: { width: number; height: number; x: number; y: number };
  burnIn?: BurnInSubtitle;
  /** HDR → SDR tone-map active. */
  tonemap: boolean;
  /** tonemap_vaapi is the chosen tone-map step (vs opencl / CPU). */
  useVaapiTonemap: boolean;
  /** libplacebo (Vulkan) is the chosen tone-map step: the RPU-aware GPU
   *  fallback for a no-base DV source when the OpenCL bridge is down (see
   *  `resolveTonemapPath`). Mutually exclusive with `useVaapiTonemap`. */
  useVulkanTonemap?: boolean;
  /** Source bit depth — picks the crop round-trip pixel format (10-bit → p010le
   *  so the HDR colour space survives the hwdownload → crop → hwupload trip). */
  sourceBitDepth: number;
  /** No-base Dolby Vision source: the CPU fallback chain reads the RPU via
   *  `tonemapx` instead of the RPU-blind `zscale` chain. */
  dvNoBase?: boolean;
  /** DV source whose RPU the GPU tone-maps apply: see `dvAppliesRpu`. */
  dvApplyRpu: boolean;
  /** HDR→SDR tone-map curve; absent falls back to {@link DEFAULT_TONEMAP_CURVE}. */
  tonemapCurve?: TonemapCurve;
  /** Route the HDR→SDR tone-map through `tonemap_opencl` (GPU) instead of the
   *  CPU zscale chain: see {@link isOpenclTonemapPath} in `encode-pipeline.ts`
   *  (NVENC/AMF, or a DV source that needs the RPU-aware bounce). */
  openclTonemap?: boolean;
  /** Route NVENC's HDR→SDR tone-map through `tonemap_cuda` (zero-copy).
   *  See {@link isCudaTonemapPath} in `encode-pipeline.ts`. */
  cudaTonemap?: boolean;
  /** Target output width. The CPU tone-map downscales to it in linear light
   *  before tone-mapping, so the (CPU-bound) tone curve + gamut conversion run
   *  at the output resolution instead of the source's — decisive on a 4K
   *  source with no HW decode (e.g. AV1 on a pre-Ampere NVIDIA GPU), where
   *  tone-mapping at 2160p drops below real-time. */
  scaleWidth: number;
  /** No-base DV reshaped to HDR10 (PQ/BT.2020) instead of SDR: the RPU
   *  reshape targets a static PQ signal, so no tone curve runs (`apply_dovi=1`
   *  reshapes IPT to PQ, it doesn't compress dynamic range). Only ever set
   *  alongside `dvNoBase`. */
  hdr10Target?: boolean;
  /** Target output height, used only by the Vulkan path: libplacebo's `h=-2`
   *  derives from the uncropped input, so a crop needs the real height or
   *  `fit_mode=fill` stretches the picture. Other paths keep `h=-2`. */
  scaleHeight?: number;
}

/**
 * Build the per-step `-vf` filter pieces the encoder descriptors splice into
 * their own scale/encode chain (vpp_qsv / scale_vaapi / CPU scale) — kept as
 * separate strings, not one graph, since each assembles them differently.
 * Tone-map is one of four mutually-exclusive variants (opencl / vaapi /
 * vulkan / CPU); text burn-in stays on whichever GPU tonemap is active
 * (bounces to CPU only for `subtitles=...`, added later by the caller),
 * except vulkan, which has no burn-in bounce and forces CPU.
 */
export function buildVideoFilters(
  ctx: VideoFilterContext,
): EncoderInput['filters'] {
  const {
    crop,
    burnIn,
    tonemap,
    useVaapiTonemap,
    useVulkanTonemap,
    sourceBitDepth,
    dvNoBase,
    dvApplyRpu,
    tonemapCurve,
    scaleWidth,
    scaleHeight,
    openclTonemap,
    cudaTonemap,
    hdr10Target,
  } = ctx;
  const curve = tonemapCurve ?? DEFAULT_TONEMAP_CURVE;
  const cropStr = crop
    ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`
    : '';
  const cpuCropPrefix = cropStr ? `${cropStr},` : '';
  const burnInFilter = burnIn?.filter ? `,${burnIn.filter}` : '';
  // `hdr10Target` only ever reaches here once dvNoBaseHdr10PathSupported
  // (tonemap-path.ts) confirmed this exact opencl/cuda recipe was probed OK.
  const tonemapOpencl =
    tonemap && !useVaapiTonemap && !useVulkanTonemap
      ? `,hwmap=derive_device=opencl:mode=read,tonemap_opencl=${tonemapOpenclOpts({ hdr10Target, curve, applyRpu: dvApplyRpu })}`
      : '';
  const tonemapVaapi = useVaapiTonemap
    ? ',tonemap_vaapi=format=nv12:t=bt709:p=bt709:m=bt709'
    : '';
  // Vulkan (libplacebo) tone-map. Crop is a libplacebo option (`crop_*`), not
  // the hwdownload/crop/hwupload round-trip the other paths use; a Vulkan
  // filter device can't derive a VAAPI surface for a CPU-side crop.
  // No HDR10-target output exists here: `apply_dolbyvision` targets only bt709 SDR.
  const tonemapVulkan =
    useVulkanTonemap && !burnIn?.filter
      ? `hwmap=derive_device=drm,format=drm_prime,libplacebo=${
          cropStr
            ? `crop_w=${crop!.width}:crop_h=${crop!.height}:crop_x=${crop!.x}:crop_y=${crop!.y}:`
            : ''
        }w=${scaleWidth}:h=${scaleHeight ?? -2}:upscaler=none:downscaler=none:format=bgra:tonemapping=${curve}:peak_detect=0:color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=pc:apply_dolbyvision=${dvApplyRpu ? 1 : 0},format=vulkan,hwmap=derive_device=vaapi,format=vaapi,scale_vaapi=format=nv12:out_range=tv`
      : '';
  // nvenc-filters.ts decides whether the surface needs bouncing to CUDA
  // before this runs; the filter itself is a no-op on that question.
  const tonemapCuda =
    tonemap && cudaTonemap
      ? `,tonemap_cuda=${tonemapOpenclOpts({ hdr10Target, curve, applyRpu: dvApplyRpu })}`
      : '';
  // CPU tonemap: HDR (PQ/HLG BT.2020) → SDR (BT.709). The opening zscale both
  // linearises the transfer (vf_tonemap needs linear light) and downscales to
  // the output width, so the tone curve + gamut conversion run at output res
  // instead of the source's — real-time vs a stall on a 4K/no-HW-decode source.
  // dvNoBase (non-opencl case) routes through `tonemapx`, the only CPU filter
  // that reads the DV RPU. It only reshapes vdr_rpu_profile 0 (P5): measured
  // no effect on an HLG base.
  const tonemapCpu = tonemap
    ? openclTonemap
      ? hdr10Target
        ? `format=p010le,hwupload,tonemap_opencl=t=smpte2084:m=bt2020:p=bt2020:r=tv:${dvApplyDoviOpt(dvApplyRpu)}:format=p010,hwdownload,format=p010le,`
        : `format=p010le,hwupload,tonemap_opencl=t=bt709:m=bt709:p=bt709:tonemap=${curve}:desat=0:${dvApplyDoviOpt(dvApplyRpu)}:format=nv12,hwdownload,format=nv12,`
      : dvNoBase
        ? hdr10Target
          ? `scale=${scaleWidth}:-2,tonemapx=t=smpte2084:p=bt2020:m=bt2020:format=yuv420p10le:${dvApplyDoviOpt(dvNoBase)},`
          : `scale=${scaleWidth}:-2,tonemapx=t=bt709:m=bt709:p=bt709:tonemap=${curve}:desat=0:format=yuv420p,`
        : `zscale=w=${scaleWidth}:h=-2:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=${curve}:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,${HDR_STATIC_SIDEDATA_DELETE},`
    : '';
  // HW-crop round-trip: hwdownload → crop → hwupload. `format=` must match the
  // source bit depth (p010le for 10-bit) or the crop runs on 8-bit-clamped
  // pixels ahead of the tone-map.
  const cropPxFmt = sourceBitDepth === 10 ? 'p010le' : 'nv12';
  const hwCropPrefix = cropStr
    ? `hwdownload,format=${cropPxFmt},${cropStr},hwupload=derive_device=vaapi,`
    : '';
  return {
    cropStr,
    cpuCropPrefix,
    hwCropPrefix,
    burnInFilter,
    tonemapVaapi,
    tonemapVulkan,
    tonemapOpencl,
    tonemapCuda,
    tonemapCpu,
  };
}
