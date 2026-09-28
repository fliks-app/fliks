import {
  isTonemapOpenclEnabled,
  isTonemapOpenclEnabledWithCrop,
} from './codec/tonemap-opencl-probe';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
import { isQsvOpenclTonemapEnabled } from './codec/qsv-opencl-probe';
import { isVulkanTonemapEnabled } from './codec/vulkan-tonemap-probe';
import { hostHasVaapi } from './hw-device';
import type { TonemapAlgo } from './types';

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
 *  - `'vulkan'` is never picked here except for a no-base DV source: it
 *    is the RPU-aware GPU fallback when the OpenCL bridge is down, not
 *    a general HDR10/HLG path (`'auto'` for those is unchanged).
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
  // A no-base DV source has no HDR10/HLG fallback the RPU-blind vaapi/qsv
  // tonemap can read, so the OpenCL bridge wins over the admin's pick;
  // the Vulkan (libplacebo) GPU path is the next choice when that bridge
  // is down, ahead of falling to the CPU (see resolveEncodePipeline).
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
