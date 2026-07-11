import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Whether the Vulkan/libplacebo Dolby Vision tonemap path works on this host:
 *  a Vulkan device inits, the libplacebo filter loads and accepts
 *  `apply_dolbyvision`, and the hwupload → filter → hwdownload round-trip runs.
 *  Fail-closed (`probedOnce && enabled`) so a P5 source before/without the probe
 *  takes the standard-tonemap fallback rather than emitting a broken vulkan init.
 *  The probe validates plumbing on a synthetic PQ sample; it does NOT prove a
 *  real DV RPU survives decode → hwupload → libplacebo (only a real P5 file can).
 */
let probedOnce = false;
let enabled = false;

export function isLibplaceboDvEnabled(): boolean {
  return probedOnce && enabled;
}

export async function runLibplaceboDvProbe(log: Logger): Promise<void> {
  const t0 = Date.now();
  const sample = path.join(
    os.tmpdir(),
    `fliks-libplacebo-dv-probe-${process.pid}.hevc`,
  );
  try {
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
        sample,
      ],
      { timeout: 15_000 },
    );
    // Same init string ffmpeg-args emits, so the probe predicts the real chain.
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        '-init_hw_device', 'vulkan=vk:0',
        '-filter_hw_device', 'vk',
        '-i', sample,
        '-vf',
        'hwupload,libplacebo=apply_dolbyvision=1:tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=nv12,hwdownload,format=nv12',
        '-c:v', 'libx264', '-preset', 'veryfast',
        '-frames:v', '1', '-f', 'null', '-',
      ],
      { timeout: 20_000 },
    );
    enabled = true;
  } catch {
    enabled = false;
  } finally {
    await unlink(sample).catch(() => {});
    probedOnce = true;
    log.log(
      `[libplacebo-dv-probe] ${enabled ? 'enabled' : 'disabled'} (${Date.now() - t0}ms)`,
    );
  }
}
