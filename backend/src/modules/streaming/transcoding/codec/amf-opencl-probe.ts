import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { findAmfNativeDecoder } from './decoders';
import { amfOpenclFilter } from './encoders/helpers/amf-filters';
import { synthesiseHdrProbeSample } from './hdr-probe-sample';

const execFileAsync = promisify(execFile);

/** Result of the AMF D3D11↔OpenCL zero-copy probe: `hwmap` the decoded D3D11
 *  texture to OpenCL, `scale_opencl`/`tonemap_opencl`, `hwmap` back to D3D11
 *  for the AMF encode, no CPU round-trip. Covers both SDR scale and HDR
 *  tonemap. Fail-closed, win32-only in practice (AMF is Windows). */
let probedOnce = false;
let enabled = false;

export function isAmfOpenclEnabled(): boolean {
  return probedOnce && enabled;
}

/** Runs one encode with `-vf` built from `amfOpenclFilter`, the same helper
 *  a real session calls, over the given decoder input args. */
async function runOnce(
  decodeArgs: string[],
  hdrSample: string,
  vf: string,
  encoderArgs: string[],
): Promise<void> {
  await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      ...decodeArgs,
      '-i',
      hdrSample,
      '-vf',
      vf,
      '-c:v',
      ...encoderArgs,
      '-frames:v',
      '2',
      '-f',
      'null',
      '-',
    ],
    { timeout: 15_000 },
  );
}

export async function runAmfOpenclProbe(log: Logger): Promise<void> {
  const t0 = Date.now();
  let failure = '';
  const hdrSample = path.join(
    os.tmpdir(),
    `fliks-amf-opencl-probe-${process.pid}.hevc`,
  );
  try {
    await synthesiseHdrProbeSample(hdrSample);

    // Same decoder descriptor a session picks, so the probe pins the same
    // AMD adapter it would decode on.
    const decodeArgs = findAmfNativeDecoder('hevc').buildInputArgs();

    // HDR10 tonemap, the h264_amf HDR→SDR case.
    await runOnce(
      decodeArgs,
      hdrSample,
      amfOpenclFilter({
        width: 320,
        height: 180,
        cropStr: '',
        tonemap: true,
        outputFormat: 'nv12',
      }),
      ['h264_amf'],
    );
    // 10-bit passthrough scale, the hevc_amf HDR10 rung (no tonemap).
    await runOnce(
      decodeArgs,
      hdrSample,
      amfOpenclFilter({
        width: 320,
        height: 180,
        cropStr: '',
        tonemap: false,
        outputFormat: 'p010le',
      }),
      ['hevc_amf', '-profile:v', 'main10'],
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
