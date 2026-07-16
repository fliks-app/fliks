import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Whether the native `scale_d3d11` filter works on this host: it scales D3D11
 *  surfaces on the GPU (D3D11 Video Processor), keeping the AMF pipeline
 *  zero-copy end to end (d3d11 decode → scale_d3d11 → AMF encode). The filter
 *  only exists in FFmpeg ≥ 8.1; on older bundles the probe fails and the AMF
 *  path takes the CPU scale (or the libplacebo path). Fail-closed. */
let probedOnce = false;
let enabled = false;

export function isScaleD3d11Enabled(): boolean {
  return probedOnce && enabled;
}

export async function runScaleD3d11Probe(log: Logger): Promise<void> {
  const t0 = Date.now();
  let failure = '';
  const sample = path.join(
    os.tmpdir(),
    `fliks-scale-d3d11-probe-${process.pid}.h264`,
  );
  try {
    // 1080p H.264 sample — a realistic downscale so the probe exercises the same
    // texture allocation a real session does (the output-texture rejection some
    // GPUs return is size-sensitive). d3d11va decodes H.264 on every Windows GPU.
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30',
        '-frames:v', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        sample,
      ],
      { timeout: 15_000 },
    );
    // The exact full-GPU chain a session runs: d3d11 decode → scale_d3d11 →
    // AMF encode, all on GPU surfaces.
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        '-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11',
        '-i', sample,
        '-vf', 'scale_d3d11=width=1280:height=720:format=nv12',
        '-c:v', 'hevc_amf', '-frames:v', '2', '-f', 'null', '-',
      ],
      { timeout: 20_000 },
    );
    enabled = true;
  } catch (err) {
    enabled = false;
    const stderr = (err as { stderr?: string }).stderr?.trim();
    failure = stderr ? stderr.split('\n').slice(-2).join(' ') : '';
  } finally {
    await unlink(sample).catch(() => {});
    probedOnce = true;
    log.log(
      `[scale-d3d11-probe] enabled=${enabled} (${Date.now() - t0}ms)${failure ? ` — ${failure}` : ''}`,
    );
  }
}
