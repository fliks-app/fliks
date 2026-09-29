import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import { promisify } from 'util';
import { synthesiseHdrProbeSample } from './hdr-probe-sample';
import { createCapabilityProbe, probeSamplePath } from './probe-utils';

const execFileAsync = promisify(execFile);

/** Windows-only: whether the D3D11↔OpenCL zero-copy tone-map bridge works
 *  (needs the bundled ffmpeg's P010 patch + a P010-capable Intel OpenCL ICD).
 *  Linux QSV uses the VAAPI-derived bridge instead (`tonemap-opencl-probe.ts`). */
const probe = createCapabilityProbe('qsv-opencl-probe');

export const isQsvOpenclTonemapEnabled = probe.isEnabled;

/** No-base Dolby Vision reshaped to HDR10 (`apply_dovi=1`, PQ/BT.2020), a
 *  distinct option/format set from the SDR recipe above, probed separately. */
const hdr10Probe = createCapabilityProbe('qsv-opencl-hdr10-probe');

export const isQsvOpenclTonemapHdr10Enabled = hdr10Probe.isEnabled;

function runVf(hdrSample: string, vf: string, encoder: string[]): Promise<void> {
  return execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-init_hw_device',
      'd3d11va=dx',
      '-init_hw_device',
      'qsv=qs@dx',
      '-init_hw_device',
      'opencl=ocl@dx',
      '-filter_hw_device',
      'ocl',
      '-hwaccel',
      'd3d11va',
      '-hwaccel_output_format',
      'd3d11',
      '-hwaccel_device',
      'dx',
      '-i',
      hdrSample,
      '-vf',
      vf,
      '-c:v',
      ...encoder,
      '-preset',
      'veryfast',
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ],
    { timeout: 15_000 },
  ).then(() => {});
}

export async function runQsvOpenclTonemapProbe(log: Logger): Promise<void> {
  const hdrSample = probeSamplePath('qsv-opencl');
  try {
    // The exact Windows chain a session runs: d3d11 decode → map to QSV →
    // vpp_qsv scale (p010) → map to OpenCL → tonemap → map back to QSV →
    // h264_qsv. Same chain the encoder emits.
    const sdrOk = await probe.run(log, async () => {
      await synthesiseHdrProbeSample(hdrSample);
      await runVf(
        hdrSample,
        'hwmap=derive_device=qsv,' +
          'vpp_qsv=w=320:h=176:format=p010le,' +
          'hwmap=derive_device=opencl,' +
          'tonemap_opencl=tonemap=hable:t=bt709:m=bt709:p=bt709:format=nv12:desat=0,' +
          'hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv',
        ['h264_qsv'],
      );
    });
    // Reuses the sample the SDR attempt just synthesised; skip the extra
    // spawn when that attempt already failed.
    if (sdrOk) {
      await hdr10Probe.run(log, () =>
        runVf(
          hdrSample,
          'hwmap=derive_device=qsv,' +
            'vpp_qsv=w=320:h=176:format=p010le,' +
            'hwmap=derive_device=opencl,' +
            'tonemap_opencl=format=p010:t=smpte2084:p=bt2020:m=bt2020:r=tv:apply_dovi=1,' +
            'hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv',
          ['hevc_qsv', '-profile:v', 'main10'],
        ),
      );
    }
  } finally {
    await unlink(hdrSample).catch(() => {});
  }
}
