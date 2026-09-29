import {
  isTonemapOpenclEnabled,
  isTonemapOpenclEnabledWithCrop,
  isTonemapOpenclHdr10Enabled,
} from './codec/tonemap-opencl-probe';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
import {
  isQsvOpenclTonemapEnabled,
  isQsvOpenclTonemapHdr10Enabled,
} from './codec/qsv-opencl-probe';
import { isVulkanTonemapEnabled } from './codec/vulkan-tonemap-probe';
import { isCudaTonemapEnabled, isCudaTonemapHdr10Enabled } from './codec/cuda-tonemap-probe';
import {
  isOpenclTonemapEnabled,
  isOpenclTonemapHdr10Enabled,
} from './codec/opencl-tonemap-probe';
import { hostHasVaapi } from './hw-device';
import type { HwAccelType, TonemapAlgo } from './types';

/** Concrete filter chain the session-time graph will use, derived from the
 *  admin `TonemapAlgo` setting + boot probe results. `'auto'` prefers opencl,
 *  then (Windows only, no VAAPI device) the vpp_qsv LUT, then vaapi; explicit
 *  picks bypass the probe, but a DV source that needs its RPU applied
 *  overrides them with opencl when the bridge passed. `'vulkan'` only comes
 *  from a no-base DV source with the OpenCL bridge down. Shared by
 *  `ffmpeg-args` and the playback-info DTO so the built chain and the
 *  reported stats can't drift. */
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
  opts: { hasCrop: boolean; dvNoBase?: boolean; dvApplyRpu?: boolean } = { hasCrop: false },
  platform: NodeJS.Platform = process.platform,
): ResolvedTonemapPath {
  // A no-base DV source overrides the admin's pick: OpenCL first, then
  // Vulkan, ahead of falling to the CPU (see resolveEncodePipeline).
  if (opts.dvNoBase) {
    if (openclBridgeOk(opts.hasCrop, platform)) return 'opencl';
    if (hostHasVaapi(platform) && isVulkanTonemapEnabled()) return 'vulkan';
  }
  // An HLG base maps far too dark without its RPU but stays watchable, so
  // OpenCL is preferred without forcing Vulkan.
  if ((algo === 'auto' || opts.dvApplyRpu) && openclBridgeOk(opts.hasCrop, platform)) {
    return 'opencl';
  }
  if (algo === 'auto') {
    // No VAAPI device (Windows): 'vaapi' isn't a QSV path, so prefer the
    // vpp_qsv fixed-function LUT when its probe passed rather than force a
    // CPU encode.
    if (!hostHasVaapi(platform) && isVppQsvTonemapEnabled()) return 'qsv';
    return 'vaapi';
  }
  return algo;
}

/** A no-base DV source reshaped to HDR10 needs its own probed `apply_dovi=1`
 *  PQ recipe per GPU path; a passing SDR nv12 probe doesn't cover it. */
export function dvNoBaseHdr10PathSupported(
  hwAccel: HwAccelType,
  algo: TonemapAlgo,
  opts: { hasCrop: boolean; hasBurnIn: boolean },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (hwAccel === 'videotoolbox') return false;
  // NVENC/AMF resolve their tonemap step independently of resolveTonemapPath
  // (see isCudaTonemapPath/isOpenclTonemapPath in encode-pipeline.ts).
  if (hwAccel === 'nvenc') {
    if (isCudaTonemapEnabled()) return isCudaTonemapHdr10Enabled();
    if (isOpenclTonemapEnabled()) return isOpenclTonemapHdr10Enabled();
    return true;
  }
  if (hwAccel === 'amf') {
    return isOpenclTonemapEnabled() ? isOpenclTonemapHdr10Enabled() : true;
  }
  const path = resolveTonemapPath(algo, { hasCrop: opts.hasCrop, dvNoBase: true }, platform);
  if (path === 'opencl') {
    return platform === 'win32'
      ? isQsvOpenclTonemapHdr10Enabled()
      : isTonemapOpenclHdr10Enabled();
  }
  // A no-base source without an opencl/vulkan bridge falls to the CPU
  // tonemapx chain instead (see dvNoBaseNeedsCpu), which needs no HW probe.
  return !(path === 'vulkan' && hwAccel === 'vaapi' && !opts.hasBurnIn);
}
