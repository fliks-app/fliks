import type { BurnInSubtitle } from './types';
import type { EncoderInput } from './codec/types';

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
  const { crop, burnIn, tonemap, useVaapiTonemap, sourceBitDepth } = ctx;
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
  // CPU tonemap chain: HDR (PQ/HLG BT.2020) → SDR (BT.709). Float → tonemap →
  // yuv420p; the `tonemap` filter handles PQ/HLG linearisation internally (no
  // zscale/libzimg dependency).
  const tonemapCpu = tonemap
    ? `format=gbrpf32le,tonemap=mobius:desat=0,format=yuv420p,`
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
