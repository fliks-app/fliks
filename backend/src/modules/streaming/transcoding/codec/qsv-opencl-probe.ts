import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Result of the Windows QSV OpenCL tone-map probe. With jellyfin-ffmpeg (P010
 *  D3D11↔OpenCL sharing) the HDR surface maps straight D3D11→OpenCL, tone-maps,
 *  and maps back to QSV — zero-copy, no CPU round-trip. This probe runs that
 *  exact chain once at boot (needs the ffmpeg P010 patch AND a P010-capable
 *  Intel OpenCL ICD) so `tonemapAlgo='auto'` and the encode-pipeline gate only
 *  pick OpenCL when it actually works — else they fall back to the vpp_qsv LUT.
 *
 *  Linux QSV derives from VAAPI and uses the QSV↔OpenCL bridge
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
    // Zero-copy: d3d11 decode → map D3D11→OpenCL → tonemap → map back to QSV →
    // vpp_qsv scale → h264_qsv. Same chain the encoder emits.
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
        'hwmap=derive_device=opencl:mode=read,' +
          'tonemap_opencl=tonemap=hable:t=bt709:m=bt709:p=bt709:format=nv12,' +
          'hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv,' +
          'vpp_qsv=w=320:h=176:format=nv12',
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
