import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { vulkanTonemapInitArgs } from '../hw-device';

const execFileAsync = promisify(execFile);

/** Standalone `libplacebo` (Vulkan) HDR->SDR capability on a VAAPI host: the
 *  Dolby Vision no-base GPU path an AMD/Intel Linux box can use instead of
 *  the CPU tonemapx fallback. Needs libdrm + a working Vulkan ICD alongside
 *  VAAPI, so it fails on hosts with no GPU Vulkan driver even though VAAPI
 *  itself works. Fail-closed until the boot probe confirms it. */
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
    // (Vulkan) tonemap -> hwmap back onto VAAPI. No encode needed — the null
    // muxer accepts the VAAPI surface the chain ends on.
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        ...vulkanTonemapInitArgs(),
        '-hwaccel', 'vaapi',
        '-hwaccel_output_format', 'vaapi',
        '-hwaccel_device', 'va',
        '-i', hdrSample,
        '-vf',
        'hwmap=derive_device=drm,format=drm_prime,' +
          'libplacebo=w=320:h=-2:upscaler=none:downscaler=none:format=bgra:' +
          'tonemapping=hable:peak_detect=0:color_primaries=bt709:color_trc=bt709:' +
          'colorspace=bt709:range=pc:apply_dolbyvision=0,' +
          'format=vulkan,hwmap=derive_device=vaapi,format=vaapi,' +
          'scale_vaapi=format=nv12:out_range=tv',
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
      `[vulkan-tonemap-probe] enabled=${enabled} (${Date.now() - t0}ms)${failure ? ` — ${failure}` : ''}`,
    );
  }
}
