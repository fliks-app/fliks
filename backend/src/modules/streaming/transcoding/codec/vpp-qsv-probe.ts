import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import { promisify } from 'util';
import { findQsvNativeDecoder } from './decoders';
import { ffmpegTail, probeSamplePath } from './probe-utils';
import { synthesiseHdrProbeSample } from './hdr-probe-sample';

const execFileAsync = promisify(execFile);

/** Whether the iGPU's fixed-function HDR tone-mapping LUT (Tiger Lake / gen11+
 *  only) actually works, probed with a real encode rather than a generation
 *  whitelist. Gates `vpp_qsv=tonemap=1` vs the `tonemap_vaapi` fallback. */
let probedOnce = false;
let enabled = false;

export function isVppQsvTonemapEnabled(): boolean {
  return probedOnce && enabled;
}

export async function runVppQsvTonemapProbe(log: Logger): Promise<void> {
  const t0 = Date.now();
  let failure = '';
  const hdrSample = probeSamplePath('vpp-qsv-tonemap');
  try {
    await synthesiseHdrProbeSample(hdrSample);

    // The session's own qsv-native decoder (VAAPI on Linux, D3D11VA on
    // Windows), so the probe can't drift from the argv a session runs.
    const decodeArgs = findQsvNativeDecoder('hevc')!.buildInputArgs();
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
        'hwmap=derive_device=qsv,vpp_qsv=tonemap=1:w=320:h=176:format=nv12',
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
  } catch (err) {
    enabled = false;
    failure = ffmpegTail(err);
  } finally {
    await unlink(hdrSample).catch(() => {});
    probedOnce = true;
    log.log(
      `[vpp-qsv-tonemap-probe] ${enabled ? 'enabled' : 'disabled'} (${Date.now() - t0}ms)${failure ? `: ${failure}` : ''}`,
    );
  }
}
