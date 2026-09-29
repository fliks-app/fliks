import {
  isTonemapOpenclEnabled,
  isTonemapOpenclEnabledWithCrop,
} from './codec/tonemap-opencl-probe';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
import { isQsvOpenclTonemapEnabled } from './codec/qsv-opencl-probe';
import { isVulkanTonemapEnabled } from './codec/vulkan-tonemap-probe';
import { hostHasVaapi } from './hw-device';
import type { HwAccelType, TonemapAlgo } from './types';

/** Concrete filter chain the session-time graph will use, derived from the
 *  admin `TonemapAlgo` setting + boot probe results. `'auto'` prefers opencl,
 *  then (Windows only, no VAAPI device) the vpp_qsv LUT, then vaapi; explicit
 *  picks bypass the probe. `'vulkan'` only comes from a no-base DV source
 *  with the OpenCL bridge down. Shared by `ffmpeg-args` and the playback-info
 *  DTO so the built chain and the reported stats can't drift. */
export type ResolvedTonemapPath = 'vaapi' | 'opencl' | 'qsv' | 'vulkan';

/** Windows QSV OpenCL is the zero-copy D3D11↔OpenCL bridge (its own probe);
 *  elsewhere it's the VAAPI-derived bridge. Shared with `encode-pipeline.ts`
 *  so the two can't drift on which probe backs `tonemapAlgo='auto'`. */
export function openclBridgeOk(hasCrop: boolean, platform: NodeJS.Platform): boolean {
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
