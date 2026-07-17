import {
  isTonemapOpenclEnabled,
  isTonemapOpenclEnabledWithCrop,
} from './codec/tonemap-opencl-probe';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
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
 *
 *  Shared between `ffmpeg-args` (which builds the filter chain) and
 *  the playback-info DTO (which surfaces the post-resolution value to
 *  the stats overlay) so the two never drift. */
export type ResolvedTonemapPath = 'vaapi' | 'opencl' | 'qsv';

export function resolveTonemapPath(
  algo: TonemapAlgo,
  opts: { hasCrop: boolean } = { hasCrop: false },
  platform: NodeJS.Platform = process.platform,
): ResolvedTonemapPath {
  if (algo === 'auto') {
    const openclOk = opts.hasCrop
      ? isTonemapOpenclEnabledWithCrop()
      : isTonemapOpenclEnabled();
    if (openclOk) return 'opencl';
    if (platform === 'win32' && isVppQsvTonemapEnabled()) return 'qsv';
    return 'vaapi';
  }
  return algo;
}
