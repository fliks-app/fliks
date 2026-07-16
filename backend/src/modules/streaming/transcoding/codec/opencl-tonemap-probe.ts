import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { openclTonemapInitArgs } from '../hw-device';

const execFileAsync = promisify(execFile);

/** Standalone `tonemap_opencl` capability, i.e. the OpenCL HDR→SDR path an
 *  NVENC/CPU encoder can use: `format=p010le,hwupload,tonemap_opencl,…,
 *  hwdownload`. This is DISTINCT from the QSV probe in `tonemap-opencl-probe`,
 *  which tests the QSV↔OpenCL surface bridge (`hwmap`) and is meaningless on a
 *  pure-NVENC host. On NVIDIA, OpenCL rides the same compute stack as
 *  CUDA/NVENC (`libnvidia-opencl.so`) — no Vulkan/GLX — so it is the only way
 *  to keep the HDR→SDR tone-map on the GPU there (mainline ffmpeg has no
 *  `tonemap_cuda`). Fail-closed until the boot probe confirms it. */
let probedOnce = false;
let enabled = false;

export function isOpenclTonemapEnabled(): boolean {
  return probedOnce && enabled;
}

export async function runOpenclTonemapProbe(log: Logger): Promise<void> {
  const t0 = Date.now();
  let failure = '';
  const hdrSample = path.join(
    os.tmpdir(),
    `fliks-opencl-tonemap-probe-${process.pid}.hevc`,
  );
  try {
    // Synthesise a tiny HEVC Main10 PQ/BT.2020 clip — black frames are fine,
    // we're only checking that the OpenCL tone-map filter graph plumbs.
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
        // Force the PQ transfer into the HEVC VUI — the -color_* flags alone
        // don't reach the raw bitstream on some builds, and tonemap_opencl
        // rejects a transfer=unknown source.
        '-x265-params',
        'repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
        hdrSample,
      ],
      { timeout: 15_000 },
    );

    // The exact chain a session uses: CPU frame → OpenCL → tonemap → CPU.
    // `opencl=ocl` auto-picks the first usable device (the NVIDIA GPU on an
    // NVENC host; a bare Intel platform with no device is skipped).
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        ...openclTonemapInitArgs(),
        '-i', hdrSample,
        '-vf',
        'format=p010le,hwupload,tonemap_opencl=t=bt709:m=bt709:p=bt709:tonemap=hable:desat=0:format=nv12,hwdownload,format=nv12',
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
      `[opencl-tonemap-probe] enabled=${enabled} (${Date.now() - t0}ms)${failure ? ` — ${failure}` : ''}`,
    );
  }
}
