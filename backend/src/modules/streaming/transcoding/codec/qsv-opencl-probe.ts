import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Result of the Windows QSV↔OpenCL tone-map probe. The Windows QSV encode
 *  path decodes on D3D11VA and can't zero-copy-map its 10-bit surface into
 *  OpenCL (the D3D11↔OpenCL bridge is NV12-only), so the higher-quality
 *  `tonemap_opencl` runs through a CPU bounce: `vpp_qsv` scales on the QSV
 *  device, the frame is downloaded, OpenCL tone-maps it, and it's handed back
 *  to the QSV encoder. This probe runs that exact chain once at boot so
 *  `tonemapAlgo='auto'` (and the encode-pipeline gate) only pick OpenCL when it
 *  actually works — otherwise it falls back to the fixed-function vpp_qsv LUT.
 *
 *  Linux QSV derives from VAAPI and uses the zero-copy QSV↔OpenCL bridge
 *  (`tonemap-opencl-probe.ts`), so this probe is win32-only. */
let probedOnce = false;
let enabled = false;

export function isQsvOpenclTonemapEnabled(): boolean {
  return probedOnce && enabled;
}

export async function runQsvOpenclTonemapProbe(log: Logger): Promise<void> {
  const t0 = Date.now();
  const hdrSample = path.join(
    os.tmpdir(),
    `fliks-qsv-opencl-probe-${process.pid}.hevc`,
  );
  try {
    // Synthesise a tiny HEVC Main10 PQ HDR bitstream (same shape as the other
    // tone-map probes — black frames are fine, we test the graph plumbing).
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'nullsrc=size=320x180:rate=30,format=yuv420p10le',
        '-frames:v',
        '8',
        '-c:v',
        'libx265',
        '-color_primaries',
        'bt2020',
        '-color_trc',
        'smpte2084',
        '-colorspace',
        'bt2020nc',
        '-x265-params',
        [
          'hdr-opt=1',
          'repeat-headers=1',
          'colorprim=bt2020',
          'transfer=smpte2084',
          'colormatrix=bt2020nc',
          'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)',
          'max-cll=1000,400',
        ].join(':'),
        hdrSample,
      ],
      { timeout: 15_000 },
    );

    // The exact Windows chain a session runs: d3d11va decode → map to QSV →
    // vpp_qsv scale (p010) → CPU bounce → tonemap_opencl (nv12) → h264_qsv.
    await execFileAsync(
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
        'opencl=ocl',
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
        'hwmap=derive_device=qsv,vpp_qsv=w=320:h=176:format=p010le,' +
          'hwdownload,format=p010le,hwupload,' +
          'tonemap_opencl=tonemap=hable:t=bt709:m=bt709:p=bt709:format=nv12,' +
          'hwdownload,format=nv12',
        '-c:v',
        'h264_qsv',
        '-preset',
        'veryfast',
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ],
      { timeout: 15_000 },
    );
    enabled = true;
  } catch {
    enabled = false;
  } finally {
    await unlink(hdrSample).catch(() => {});
    probedOnce = true;
    log.log(
      `[qsv-opencl-probe] ${enabled ? 'enabled' : 'disabled'} (${Date.now() - t0}ms)`,
    );
  }
}
