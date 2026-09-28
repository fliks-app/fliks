import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { amfD3d11OpenclInitArgs } from '../hw-device';

const execFileAsync = promisify(execFile);

/** Result of the AMF D3D11↔OpenCL zero-copy probe: `hwmap` the decoded D3D11
 *  texture to OpenCL, `scale_opencl`/`tonemap_opencl`, `hwmap` back to D3D11
 *  for the AMF encode, no CPU round-trip. Covers both SDR scale (replacing
 *  the buggy `scale_d3d11`, which scales the decoder's alignment padding)
 *  and HDR tonemap. Fail-closed, win32-only in practice (AMF is Windows). */
let probedOnce = false;
let enabled = false;

export function isAmfOpenclEnabled(): boolean {
  return probedOnce && enabled;
}

export async function runAmfOpenclProbe(log: Logger): Promise<void> {
  const t0 = Date.now();
  let failure = '';
  const hdrSample = path.join(
    os.tmpdir(),
    `fliks-amf-opencl-probe-${process.pid}.hevc`,
  );
  try {
    // Synthesise a tiny HEVC Main10 PQ HDR bitstream, same shape as the
    // other tone-map probes, black frames are fine, we test the plumbing.
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

    // The exact Windows chain a session runs: d3d11 decode → hwmap to OpenCL
    // → scale + tonemap → hwmap back to d3d11 → AMF encode.
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        ...amfD3d11OpenclInitArgs(),
        '-hwaccel',
        'd3d11va',
        '-hwaccel_output_format',
        'd3d11',
        '-hwaccel_device',
        'dx',
        '-extra_hw_frames',
        '32',
        '-i',
        hdrSample,
        '-vf',
        'hwmap=derive_device=opencl:mode=read,' +
          'scale_opencl=w=320:h=180,' +
          'tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=hable:desat=0:apply_dovi=0,' +
          'hwmap=derive_device=d3d11va:mode=write:reverse=1,format=d3d11',
        '-c:v',
        'h264_amf',
        '-frames:v',
        '2',
        '-f',
        'null',
        '-',
      ],
      { timeout: 15_000 },
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
      `[amf-opencl-probe] enabled=${enabled} (${Date.now() - t0}ms)${failure ? `: ${failure}` : ''}`,
    );
  }
}
