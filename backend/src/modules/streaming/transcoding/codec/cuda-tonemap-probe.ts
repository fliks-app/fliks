import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Whether `tonemap_cuda` works on this host, keeping the HDR→SDR tone-map on
 *  the CUDA surface end to end. Fail-closed; falls back to the OpenCL bounce. */
let probedOnce = false;
let enabled = false;

export function isCudaTonemapEnabled(): boolean {
  return probedOnce && enabled;
}

export async function runCudaTonemapProbe(log: Logger): Promise<void> {
  const t0 = Date.now();
  let failure = '';
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'nullsrc=size=320x180:rate=30',
        '-vf',
        'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=p010le,hwupload_cuda,scale_cuda=w=160:h=-2:format=p010le,tonemap_cuda=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=hable:desat=0:apply_dovi=0,hwdownload,format=nv12',
        '-frames:v', '1',
        '-f', 'null', '-',
      ],
      { timeout: 15_000 },
    );
    enabled = true;
  } catch (err) {
    enabled = false;
    const stderr = (err as { stderr?: string }).stderr?.trim();
    failure = stderr ? stderr.split('\n').slice(-2).join(' ') : '';
  } finally {
    probedOnce = true;
    log.log(
      `[cuda-tonemap-probe] enabled=${enabled} (${Date.now() - t0}ms)${failure ? `: ${failure}` : ''}`,
    );
  }
}
