import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import { promisify } from 'util';
import { qsvDeviceInitArgs, qsvViaD3d11DeviceInitArgs } from '../hw-device';
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

    // Decode the same way a real session does (decoders/qsv.ts: VAAPI on
    // Linux, D3D11VA on Windows — never the `-hwaccel qsv` wrapper), hwmap
    // onto QSV, run vpp_qsv tonemap, encode 1 frame with h264_qsv.
    const win = process.platform === 'win32';
    const decodeInit = win ? qsvViaD3d11DeviceInitArgs() : qsvDeviceInitArgs();
    const decodeHwaccel = win
      ? ['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11', '-hwaccel_device', 'dx']
      : ['-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-hwaccel_device', 'va'];
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        ...decodeInit,
        '-filter_hw_device',
        'qs',
        ...decodeHwaccel,
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
