import { existsSync } from 'fs';
import { QsvExtractor } from './qsv.extractor';
import { SwExtractor } from './sw.extractor';
import type { CropArea, ExtractorBackend } from './types';
import { VaapiExtractor } from './vaapi.extractor';
import { VideoToolboxExtractor } from './videotoolbox.extractor';

export type { CropArea, ExtractArgs, ExtractorBackend } from './types';

/**
 * HW render node for accelerated decode on Linux (VAAPI / QSV). Honors
 * `THUMB_HWACCEL_DEVICE` env var — set to `off` to force SW, or to a
 * specific `/dev/dri/renderD12X` path. With no override we prefer the
 * higher-numbered render node — discrete GPUs (Arc, AMD dGPU) typically
 * enumerate after the iGPU and have a much faster decoder.
 */
const HWACCEL_DEVICE: string | null = (() => {
  const env = process.env.THUMB_HWACCEL_DEVICE;
  if (env === 'off') return null;
  const candidates = env
    ? [env]
    : ['/dev/dri/renderD129', '/dev/dri/renderD128'];
  for (const dev of candidates) {
    if (existsSync(dev)) return dev;
  }
  return null;
})();

/**
 * Ordered list of available backends. The factory walks this list and
 * returns the first one whose {@link ExtractorBackend.supports} accepts
 * the requested crop config. {@link SwExtractor} accepts anything, so the
 * list always terminates.
 *
 * Order matters:
 *   • VAAPI before QSV — VAAPI is markedly faster on no-crop sprites.
 *   • QSV before SW — QSV's `vpp_qsv` handles HW crop+scale.
 *   • VideoToolbox on Darwin replaces the Linux HW pair entirely.
 */
const BACKENDS: ExtractorBackend[] = (() => {
  if (process.platform === 'darwin') {
    return [new VideoToolboxExtractor(), new SwExtractor()];
  }
  if (HWACCEL_DEVICE) {
    return [
      new VaapiExtractor(HWACCEL_DEVICE),
      new QsvExtractor(HWACCEL_DEVICE),
      new SwExtractor(),
    ];
  }
  return [new SwExtractor()];
})();

/** Pick the highest-priority backend that can handle the given crop.
 *  `forceSoftware` skips every HW backend and returns the CPU extractor —
 *  used to keep sprite decodes off the GPU while a live transcode owns it. */
export function pickExtractor(
  crop?: CropArea,
  forceSoftware = false,
): ExtractorBackend {
  for (const b of BACKENDS) {
    if (forceSoftware && b.name !== 'sw') continue;
    if (b.supports(crop)) return b;
  }
  // Unreachable — SwExtractor.supports() always returns true.
  return new SwExtractor();
}

/** Whether any HW-accelerated backend is configured. Used by the service
 *  to size its worker pool (HW saturates earlier than CPU). */
export const HWACCEL_AVAILABLE = BACKENDS.some((b) => b.name !== 'sw');

/** Human-readable summary of the configured backends — logged once at
 *  service init so deployments can confirm HW is being used. */
export function describeBackends(): string {
  return BACKENDS.map((b) => b.describe()).join(' → ');
}
