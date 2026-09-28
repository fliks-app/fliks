import {
  isTonemapOpenclEnabled,
  isTonemapOpenclEnabledWithCrop,
} from './codec/tonemap-opencl-probe';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
import { isQsvOpenclTonemapEnabled } from './codec/qsv-opencl-probe';
import { isVulkanTonemapEnabled } from './codec/vulkan-tonemap-probe';
import { hostHasVaapi } from './hw-device';
import type { HwAccelType, TonemapAlgo } from './types';

/** Concrete filter chain the session-time graph will actually use,
 *  derived from the admin `TonemapAlgo` setting + boot probe results.
 *
 *  - `'auto'` resolves to `'opencl'` when the matching boot probe
 *    enabled it (separate probes run with and without a crop prefix
 *    because some Intel iHD builds accept the basic opencl chain but
 *    fail the cropped variant). Otherwise it falls back to `'qsv'` on
 *    Windows (the vpp_qsv fixed-function LUT) when that probe passed,
 *    and to `'vaapi'` elsewhere. The Windows split matters because
 *    Windows has no VAAPI device: `'vaapi'` there is not a QSV path at
 *    all, so it would force the session onto a CPU encode. On Linux
 *    QSV is VAAPI-backed, so `'vaapi'` stays a valid on-GPU tone-map.
 *  - Explicit picks (`'vaapi'` / `'qsv'` / `'opencl'`) bypass the
 *    probe and trust the admin to know their hardware.
 *  - `'vulkan'` only comes from a no-base DV source with the OpenCL bridge
 *    down; `'auto'` for HDR10/HLG is unchanged.
 *
 *  Shared between `ffmpeg-args` (which builds the filter chain) and
 *  the playback-info DTO (which surfaces the post-resolution value to
 *  the stats overlay) so the two never drift. */
export type ResolvedTonemapPath = 'vaapi' | 'opencl' | 'qsv' | 'vulkan';

/** Windows QSV OpenCL is the CPU-bounce path (its own probe); elsewhere it's
 *  the VAAPI-derived bridge. */
function openclBridgeOk(hasCrop: boolean, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? isQsvOpenclTonemapEnabled()
    : hasCrop
      ? isTonemapOpenclEnabledWithCrop()
      : isTonemapOpenclEnabled();
}

export function resolveTonemapPath(
  algo: TonemapAlgo,
  opts: { hasCrop: boolean; dvNoBase?: boolean } = { hasCrop: false },
  platform: NodeJS.Platform = process.platform,
): ResolvedTonemapPath {
  // A no-base DV source overrides the admin's pick: OpenCL first, then
  // Vulkan, ahead of falling to the CPU (see resolveEncodePipeline).
  if (opts.dvNoBase) {
    if (openclBridgeOk(opts.hasCrop, platform)) return 'opencl';
    if (hostHasVaapi(platform) && isVulkanTonemapEnabled()) return 'vulkan';
  }
  if (algo === 'auto') {
    if (openclBridgeOk(opts.hasCrop, platform)) return 'opencl';
    // No VAAPI device (Windows): 'vaapi' isn't a QSV path, so prefer the
    // vpp_qsv fixed-function LUT when its probe passed rather than force a
    // CPU encode.
    if (!hostHasVaapi(platform) && isVppQsvTonemapEnabled()) return 'qsv';
    return 'vaapi';
  }
  return algo;
}

/** A no-base DV source reshaped to HDR10 (not SDR) is only verified on the
 *  OpenCL bounce, NVENC's CUDA/OpenCL tonemaps, and the CPU tonemapx chain ;
 *  not the Vulkan (libplacebo) or VideoToolbox Metal paths. Gates the variant
 *  selector so those two keep falling back to the SDR tonemap instead of
 *  tagging HDR10 metadata onto pixels their filter chain never produced. */
export function dvNoBaseHdr10PathSupported(
  hwAccel: HwAccelType,
  algo: TonemapAlgo,
  opts: { hasCrop: boolean; hasBurnIn: boolean },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (hwAccel === 'videotoolbox') return false;
  const path = resolveTonemapPath(algo, { hasCrop: opts.hasCrop, dvNoBase: true }, platform);
  return !(path === 'vulkan' && hwAccel === 'vaapi' && !opts.hasBurnIn);
}
