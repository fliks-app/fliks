import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { vulkanTonemapInitArgs } from '../hw-device';
import { buildVideoFilters } from '../ffmpeg-filter-graph';

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
  const hdrSample = path.join(
    os.tmpdir(),
    `fliks-vulkan-tonemap-probe-${process.pid}.hevc`,
  );
  try {
    // Same synthesised HEVC Main10 PQ source as the other tone-map probes.
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi',
        '-i', 'nullsrc=size=320x180:rate=30,format=yuv420p10le',
        '-frames:v', '4',
        '-c:v', 'libx265',
        '-color_primaries', 'bt2020',
        '-color_trc', 'smpte2084',
        '-colorspace', 'bt2020nc',
        '-x265-params',
        'repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
        hdrSample,
      ],
      { timeout: 15_000 },
    );

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
    const stderr = (err as { stderr?: string }).stderr?.trim();
    failure = stderr ? stderr.split('\n').slice(-2).join(' ') : '';
  } finally {
    await unlink(hdrSample).catch(() => {});
    probedOnce = true;
    log.log(
      `[vulkan-tonemap-probe] enabled=${enabled} (${Date.now() - t0}ms)${failure ? `; ${failure}` : ''}`,
    );
  }
}
