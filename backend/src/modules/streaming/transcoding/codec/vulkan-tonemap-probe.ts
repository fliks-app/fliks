import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import { promisify } from 'util';
import { vulkanTonemapInitArgs } from '../hw-device';
import { buildVideoFilters } from '../ffmpeg-filter-graph';
import { ffmpegTail, probeSamplePath } from './probe-utils';
import { synthesiseHdrProbeSample } from './hdr-probe-sample';

const execFileAsync = promisify(execFile);

/** Standalone `libplacebo` (Vulkan) HDR->SDR capability on a VAAPI host: the
 *  Dolby Vision no-base GPU fallback when the OpenCL bridge is down.
 *  Fail-closed until the boot probe confirms it. */
let probedOnce = false;
let enabled = false;

export function isVulkanTonemapEnabled(): boolean {
  return probedOnce && enabled;
}

export async function runVulkanTonemapProbe(log: Logger): Promise<void> {
  const t0 = Date.now();
  let failure = '';
  const hdrSample = probeSamplePath('vulkan-tonemap');
  try {
    await synthesiseHdrProbeSample(hdrSample);

    // The exact session graph: VAAPI decode -> hwmap onto DRM -> libplacebo
    // (Vulkan) tonemap -> hwmap back onto VAAPI. No encode needed; the null
    // muxer accepts the VAAPI surface the chain ends on. Built from the same
    // `buildVideoFilters` the real session uses, so the two can't drift.
    const vf = buildVideoFilters({
      tonemap: true,
      useVaapiTonemap: false,
      useVulkanTonemap: true,
      sourceBitDepth: 10,
      scaleWidth: 320,
    }).tonemapVulkan;
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        ...vulkanTonemapInitArgs(),
        '-hwaccel', 'vaapi',
        '-hwaccel_output_format', 'vaapi',
        '-hwaccel_device', 'va',
        '-i', hdrSample,
        '-vf', vf,
        '-frames:v', '1',
        '-f', 'null', '-',
      ],
      { timeout: 20_000 },
    );
    enabled = true;
  } catch (err) {
    enabled = false;
    failure = ffmpegTail(err);
  } finally {
    await unlink(hdrSample).catch(() => {});
    probedOnce = true;
    log.log(
      `[vulkan-tonemap-probe] enabled=${enabled} (${Date.now() - t0}ms)${failure ? `; ${failure}` : ''}`,
    );
  }
}
