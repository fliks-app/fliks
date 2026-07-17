import type { BurnInSubtitle } from './types';
import type { EncoderInput } from './codec/types';

/** CPU HDR→SDR tone-map curve. `hable` is a filmic curve with a gentle
 *  highlight rolloff (retains specular detail on high-nit HDR10); `mobius`
 *  is punchier with a harder highlight knee. */
export type TonemapCurve = 'hable' | 'mobius';

/** Resolve the CPU tone-map curve from the optional `TRANSCODE_TONEMAP_CURVE`
 *  env var, defaulting to `hable`. */
export function resolveTonemapCurve(): TonemapCurve {
  return process.env.TRANSCODE_TONEMAP_CURVE === 'mobius' ? 'mobius' : 'hable';
}

export interface VideoFilterContext {
  crop?: { width: number; height: number; x: number; y: number };
  burnIn?: BurnInSubtitle;
  /** HDR → SDR tone-map active. */
  tonemap: boolean;
  /** tonemap_vaapi is the chosen tone-map step (vs opencl / CPU). */
  useVaapiTonemap: boolean;
  /** Source bit depth — picks the crop round-trip pixel format (10-bit → p010le
   *  so the HDR colour space survives the hwdownload → crop → hwupload trip). */
  sourceBitDepth: number;
  /** Dolby Vision P5: tonemap via the RPU-aware libplacebo (Vulkan) chain
   *  instead of the standard tonemap that misreads IPT-C2 (#636). */
  dovi?: boolean;
  /** CPU HDR→SDR tone-map curve (`hable` default, `mobius` optional). */
  tonemapCurve?: TonemapCurve;
  /** Route the HDR→SDR tone-map through `tonemap_opencl` (GPU) instead of the
   *  CPU zscale chain. Set for NVENC sessions when the OpenCL tone-map probe
   *  passed — on NVIDIA this keeps the tone-map on the GPU (there is no
   *  tonemap_cuda), turning a 4K source's ~0.5x CPU tone-map into >1x. */
  openclTonemap?: boolean;
  /** Target output width. The CPU tone-map downscales to it in linear light
   *  before tone-mapping, so the (CPU-bound) tone curve + gamut conversion run
   *  at the output resolution instead of the source's — decisive on a 4K
   *  source with no HW decode (e.g. AV1 on a pre-Ampere NVIDIA GPU), where
   *  tone-mapping at 2160p drops below real-time. */
  scaleWidth: number;
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
 *  - tone-map: three mutually-exclusive variants — opencl (vpp_qsv → hwmap
 *    opencl → tonemap_opencl → hwmap qsv), vaapi (tonemap_vaapi), and CPU
 *    (float → tonemap mobius → yuv420p). Burn-in forces the CPU path (libass
 *    needs CPU buffers), so the HW tone-maps are gated on no burn-in.
 */
export function buildVideoFilters(
  ctx: VideoFilterContext,
): EncoderInput['filters'] {
  const {
    crop,
    burnIn,
    tonemap,
    useVaapiTonemap,
    sourceBitDepth,
    dovi,
    tonemapCurve,
    scaleWidth,
    openclTonemap,
  } = ctx;
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
  // `openclTonemap` (NVENC + OpenCL GPU) keeps the tone-map on the GPU:
  // upload the CPU frame to OpenCL, tonemap_opencl (linearises + BT.2020→709
  // + curve internally), download back. tonemap_opencl has no bt2390 in
  // ffmpeg 6.1, so it uses the same hable/mobius curve as the CPU chain.
  const curve = tonemapCurve ?? 'hable';
  const tonemapCpu = tonemap
    ? dovi
      ? `hwupload,libplacebo=apply_dolbyvision=1:tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=nv12,hwdownload,format=nv12,`
      : openclTonemap
        ? `format=p010le,hwupload,tonemap_opencl=t=bt709:m=bt709:p=bt709:tonemap=${curve}:desat=0:format=nv12,hwdownload,format=nv12,`
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
    tonemapOpencl,
    tonemapCpu,
  };
}
