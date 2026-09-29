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

export async function runOpenclTonemapProbe(
  log: Logger,
  hwAccel: HwAccelType,
): Promise<void> {
  const hdrSample = probeSamplePath('opencl-tonemap');
  await probe.run(log, async () => {
    try {
      await synthesiseHdrProbeSample(hdrSample);

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
      await execFileAsync(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error',
          ...decodeArgs,
          ...openclTonemapInitArgs(),
          '-i', hdrSample,
          '-vf',
          `${download}format=p010le,hwupload,tonemap_opencl=t=bt709:m=bt709:p=bt709:tonemap=hable:desat=0:format=nv12,hwdownload,format=nv12`,
          '-frames:v', '1',
          '-f', 'null', '-',
        ],
        { timeout: 20_000 },
      );
    } finally {
      await unlink(hdrSample).catch(() => {});
    }
  });
}
