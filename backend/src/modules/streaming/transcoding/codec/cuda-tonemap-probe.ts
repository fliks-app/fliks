import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createCapabilityProbe } from './probe-utils';

const execFileAsync = promisify(execFile);

/** Whether `tonemap_cuda` works on this host, keeping the HDR->SDR tone-map on
 *  the CUDA surface end to end. Fail-closed; falls back to the OpenCL bounce. */
const probe = createCapabilityProbe('cuda-tonemap-probe');

export const isCudaTonemapEnabled = probe.isEnabled;

/** No-base Dolby Vision reshaped to HDR10 (`apply_dovi=1`, PQ/BT.2020), a
 *  distinct option/format set from the SDR recipe above, probed separately. */
const hdr10Probe = createCapabilityProbe('cuda-tonemap-hdr10-probe');

export const isCudaTonemapHdr10Enabled = hdr10Probe.isEnabled;

async function runVf(vf: string): Promise<void> {
  await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'nullsrc=size=320x180:rate=30',
      '-vf', vf,
      '-frames:v', '1',
      '-f', 'null', '-',
    ],
    { timeout: 15_000 },
  );
}

export async function runCudaTonemapProbe(log: Logger): Promise<void> {
  const sdrOk = await probe.run(log, () =>
    runVf(
      'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=p010le,hwupload_cuda,scale_cuda=w=160:h=-2:format=p010le,tonemap_cuda=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=hable:desat=0:apply_dovi=0,hwdownload,format=nv12',
    ),
  );
  // Same device chain as the SDR recipe; skip the extra spawn when that
  // already failed.
  if (!sdrOk) return;
  await hdr10Probe.run(log, () =>
    runVf(
      'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=p010le,hwupload_cuda,scale_cuda=w=160:h=-2:format=p010le,tonemap_cuda=format=p010:t=smpte2084:p=bt2020:m=bt2020:r=tv:apply_dovi=1,hwdownload,format=p010le',
    ),
  );
}
