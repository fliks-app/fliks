import { isTonemapOpenclEnabled } from './codec/tonemap-opencl-probe';
import type { TonemapAlgo } from './types';

/** Concrete filter chain the session-time graph will actually use,
 *  derived from the admin `TonemapAlgo` setting + boot probe results.
 *
 *  - `'auto'` resolves to `'opencl'` when the boot probe enabled it
 *    (Intel iGPU with a working QSV↔OpenCL bridge), else `'vaapi'` —
 *    that fallback covers macOS, containers without an OpenCL stack,
 *    and Intel hosts whose iHD driver fails the bridge with the
 *    `QSV to OpenCL mapping not usable` / exit=218 pattern.
 *  - Explicit picks (`'vaapi'` / `'qsv'` / `'opencl'`) bypass the
 *    probe and trust the admin to know their hardware.
 *
 *  Shared between `ffmpeg-args` (which builds the filter chain) and
 *  the playback-info DTO (which surfaces the post-resolution value to
 *  the stats overlay) so the two never drift. */
export type ResolvedTonemapPath = 'vaapi' | 'opencl' | 'qsv';

export function resolveTonemapPath(algo: TonemapAlgo): ResolvedTonemapPath {
  if (algo === 'auto') return isTonemapOpenclEnabled() ? 'opencl' : 'vaapi';
  return algo;
}
