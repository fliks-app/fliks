import {
  isTonemapOpenclEnabled,
  isTonemapOpenclEnabledWithCrop,
} from './codec/tonemap-opencl-probe';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
import { isQsvOpenclTonemapEnabled } from './codec/qsv-opencl-probe';
import { hostHasVaapi } from './hw-device';
import type { TonemapAlgo } from './types';

/** `TRANSCODE_TONEMAP_ALGO` override (auto/qsv/vaapi/opencl), applied on every
 *  platform before the `auto` resolution — pins the HDR→SDR tone-map without
 *  the admin UI (see docker-compose). Invalid/unset → null (no override). */
export function tonemapAlgoOverride(): TonemapAlgo | null {
  const v = process.env.TRANSCODE_TONEMAP_ALGO?.trim().toLowerCase();
  return v === 'auto' || v === 'qsv' || v === 'vaapi' || v === 'opencl'
    ? (v as TonemapAlgo)
    : null;
}

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
  const effective = tonemapAlgoOverride() ?? algo;
  if (effective === 'auto') {
    // Windows QSV OpenCL is the CPU-bounce path (its own probe); elsewhere it's
    // the VAAPI-derived bridge.
    const openclOk =
      platform === 'win32'
        ? isQsvOpenclTonemapEnabled()
        : opts.hasCrop
          ? isTonemapOpenclEnabledWithCrop()
          : isTonemapOpenclEnabled();
    if (openclOk) return 'opencl';
    // No VAAPI device (Windows): 'vaapi' isn't a QSV path, so prefer the
    // vpp_qsv fixed-function LUT when its probe passed rather than force a
    // CPU encode.
    if (!hostHasVaapi(platform) && isVppQsvTonemapEnabled()) return 'qsv';
    return 'vaapi';
  }
  return effective;
}
