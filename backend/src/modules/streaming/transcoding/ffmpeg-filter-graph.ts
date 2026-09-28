import type { BurnInSubtitle } from './types';
import type { EncoderInput, TonemapCurve } from './codec/types';

/** Admin-selected curve (`streaming_tonemap_curve`), pushed in by
 *  {@link setSelectedTonemapCurve}. */
let selectedCurve: TonemapCurve | null = null;

export function setSelectedTonemapCurve(curve: TonemapCurve | null): void {
  selectedCurve = curve;
}

/** Tone-map curve in force. Shared by the CPU and GPU tone-map paths. */
export function resolveTonemapCurve(): TonemapCurve {
  return selectedCurve ?? 'hable';
}

/** `tonemap_opencl` (and `tonemap_videotoolbox`) RPU-reshaping option. The
 *  bundled ffmpeg defaults it to 1; only a no-base source (see `dvHasNoBase`)
 *  has a trustworthy RPU to apply, so every other source (including has-base
 *  P7/P8) must pass 0 explicitly. */
export function dvApplyDoviOpt(dvNoBase: boolean | undefined): string {
  return `apply_dovi=${dvNoBase ? 1 : 0}`;
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
  /** CPU HDR→SDR tone-map curve (`hable` default, `mobius` optional). */
  tonemapCurve?: TonemapCurve;
  /** Route the HDR→SDR tone-map through `tonemap_opencl` (GPU) instead of the
   *  CPU zscale chain: see {@link isOpenclTonemapPath} in `encode-pipeline.ts`
   *  (NVENC/AMF, or a no-base DV source that needs the RPU-aware bounce). */
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
  /** Target output height, used only by the Vulkan path: libplacebo's `h=-2`
   *  derives from the uncropped input, so a crop needs the real height or
   *  `fit_mode=fill` stretches the picture. Other paths keep `h=-2`. */
  scaleHeight?: number;
}

/**
 * Build the per-step `-vf` filter pieces the encoder descriptors splice into
 * their scale/encode chain. Kept as separate strings (not one graph) because
 * each descriptor assembles them differently around its own scale filter
 * (vpp_qsv / scale_vaapi / CPU scale):
 *  - crop: a CPU prefix (`crop,`) and a HW round-trip prefix (hwdownload → crop
 *    → hwupload) for paths that crop off-GPU; the round-trip format matches the
 *    source bit depth so 10-bit HDR isn't silently clamped to 8-bit before the
 *    tone-map runs.
 *  - tone-map: four mutually-exclusive variants; opencl (vpp_qsv → hwmap
 *    opencl → tonemap_opencl → hwmap qsv), vaapi (tonemap_vaapi), vulkan
 *    (hwmap drm → libplacebo → hwmap vaapi, the no-base DV GPU fallback
 *    when the opencl bridge is down), and CPU (float → tonemap mobius →
 *    yuv420p). Burn-in forces the CPU path (libass needs CPU buffers), so
 *    the HW tone-maps are gated on no burn-in.
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
    tonemapCurve,
    scaleWidth,
    scaleHeight,
    openclTonemap,
    cudaTonemap,
  } = ctx;
  const curve = tonemapCurve ?? 'hable';
  const cropStr = crop
    ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`
    : '';
  const cpuCropPrefix = cropStr ? `${cropStr},` : '';
  const burnInFilter = burnIn?.filter ? `,${burnIn.filter}` : '';
  const tonemapOpencl =
    tonemap && !useVaapiTonemap && !useVulkanTonemap && !burnIn?.filter
      ? `,hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=${curve}:desat=0:${dvApplyDoviOpt(dvNoBase)}`
      : '';
  const tonemapVaapi =
    useVaapiTonemap && !burnIn?.filter
      ? ',tonemap_vaapi=format=nv12:t=bt709:p=bt709:m=bt709'
      : '';
  // Vulkan (libplacebo) tone-map. Crop is a libplacebo option (`crop_*`), not
  // the hwdownload/crop/hwupload round-trip the other paths use; a Vulkan
  // filter device can't derive a VAAPI surface for a CPU-side crop.
  const tonemapVulkan =
    useVulkanTonemap && !burnIn?.filter
      ? `hwmap=derive_device=drm,format=drm_prime,libplacebo=${
          cropStr
            ? `crop_w=${crop!.width}:crop_h=${crop!.height}:crop_x=${crop!.x}:crop_y=${crop!.y}:`
            : ''
        }w=${scaleWidth}:h=${scaleHeight ?? -2}:upscaler=none:downscaler=none:format=bgra:tonemapping=${curve}:peak_detect=0:color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=pc:apply_dolbyvision=${dvNoBase ? 1 : 0},format=vulkan,hwmap=derive_device=vaapi,format=vaapi,scale_vaapi=format=nv12:out_range=tv`
      : '';
  // The filter itself is a no-op on the round-trip question; nvenc-filters.ts
  // decides whether the surface needs bouncing to CUDA before this runs.
  const tonemapCuda =
    tonemap && cudaTonemap
      ? `,tonemap_cuda=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=${curve}:desat=0:${dvApplyDoviOpt(dvNoBase)}`
      : '';
  // CPU tonemap chain: HDR (PQ/HLG BT.2020) → SDR (BT.709). The opening zscale
  // linearises the source transfer AND downscales to the output width in one
  // pass: vf_tonemap operates on linear light only and does NOT linearise
  // itself (feeding it PQ/HLG code values collapses the picture to a washed-out
  // grey), and resampling belongs in linear light. Doing the downscale here
  // also means the CPU-bound tone curve + gamut conversion run at the output
  // resolution, not the source's — the difference between real-time and a stall
  // on a 4K source with no HW decode. Then the BT.2020 → BT.709 primaries map
  // runs in linear light, `tonemap` applies the curve, and the closing zscale
  // re-encodes to BT.709 transfer + matrix + limited range. Input colorimetry
  // is read from the frame tags, so PQ (smpte2084) and HLG (arib-std-b67) both
  // work. `h=-2` keeps the (post-crop) aspect at an even height.
  // openclTonemap: GPU bounce via tonemap_opencl, RPU applied only when
  // dvNoBase. dvNoBase (non-opencl case): `tonemapx`, the only CPU filter
  // that reads the RPU.
  const tonemapCpu = tonemap
    ? openclTonemap
      ? `format=p010le,hwupload,tonemap_opencl=t=bt709:m=bt709:p=bt709:tonemap=${curve}:desat=0:${dvApplyDoviOpt(dvNoBase)}:format=nv12,hwdownload,format=nv12,`
      : dvNoBase
        ? `scale=${scaleWidth}:-2,tonemapx=t=bt709:m=bt709:p=bt709:tonemap=${curve}:desat=0:format=yuv420p,`
        : `zscale=w=${scaleWidth}:h=-2:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=${curve}:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,`
    : '';
  // HW-crop round-trip: hwdownload → crop → hwupload. The explicit `format=`
  // matches the source bit depth (p010le for 10-bit) so crop runs in the
  // decoded surface's colour space — `nv12` here downconverts a 10-bit HDR
  // source to 8-bit BT.709-clamped pixels before the tone-map, producing a dark
  // image on cropped 2160p HDR10 sources.
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
