import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import { promisify } from 'util';
import { openclTonemapInitArgs } from '../hw-device';
import { synthesiseHdrProbeSample } from './hdr-probe-sample';
import { createCapabilityProbe, probeSamplePath } from './probe-utils';
import type { HwAccelType } from '../types';

const execFileAsync = promisify(execFile);

/** Standalone `tonemap_opencl` capability: NVENC's fallback bounce when
 *  `tonemap_cuda` isn't available, and AMF's only GPU tonemap. Fail-closed. */
const probe = createCapabilityProbe('opencl-tonemap-probe');

export const isOpenclTonemapEnabled = probe.isEnabled;

/** No-base Dolby Vision reshaped to HDR10 (`apply_dovi=1`, PQ/BT.2020), a
 *  distinct option/format set from the SDR recipe above, probed separately. */
const hdr10Probe = createCapabilityProbe('opencl-tonemap-hdr10-probe');

export const isOpenclTonemapHdr10Enabled = hdr10Probe.isEnabled;

export async function runOpenclTonemapProbe(
  log: Logger,
  hwAccel: HwAccelType,
): Promise<void> {
  const hdrSample = probeSamplePath('opencl-tonemap');
  // Mirror the session graph so a pass implies the real graph inits: HW
  // decode (NVDEC / d3d11va) coexisting with the OpenCL filter device. cuda
  // surfaces are downloaded before the OpenCL hwupload; d3d11va auto-downloads.
  const decodeArgs =
    hwAccel === 'nvenc'
      ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']
      : hwAccel === 'amf'
        ? ['-hwaccel', 'd3d11va']
        : [];
  const download = hwAccel === 'nvenc' ? 'hwdownload,format=p010le,' : '';
  const runVf = (vf: string): Promise<void> =>
    execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        ...decodeArgs,
        ...openclTonemapInitArgs(),
        '-i', hdrSample,
        '-vf', vf,
        '-frames:v', '1',
        '-f', 'null', '-',
      ],
      { timeout: 20_000 },
    ).then(() => {});
  try {
    const sdrOk = await probe.run(log, async () => {
      await synthesiseHdrProbeSample(hdrSample);
      await runVf(
        `${download}format=p010le,hwupload,tonemap_opencl=t=bt709:m=bt709:p=bt709:tonemap=hable:desat=0:format=nv12,hwdownload,format=nv12`,
      );
    });
    // Reuses the sample the SDR attempt just synthesised; skip the extra
    // spawn when that attempt already failed.
    if (sdrOk) {
      await hdr10Probe.run(log, () =>
        runVf(
          `${download}format=p010le,hwupload,tonemap_opencl=format=p010:t=smpte2084:p=bt2020:m=bt2020:r=tv:apply_dovi=1,hwdownload,format=p010le`,
        ),
      );
    }
  } finally {
    await unlink(hdrSample).catch(() => {});
  }
}
