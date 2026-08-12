import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { HwAccelType } from './types';
import { hostHasVaapi, qsvDeviceInitArgs, vaapiDeviceInitArgs } from './hw-device';

const execFileAsync = promisify(execFile);

type HwTest = { type: HwAccelType; args: string[] };

// 320x240, not a tiny 64x64: AMD's VCN encoder rejects sub-minimum
// resolutions with "Invalid argument", which made the AMF probe fail on iGPUs.
const BLACK_INPUT = ['-f', 'lavfi', '-i', 'color=black:s=320x240:d=0.1'];
const ONE_FRAME_NULL = ['-frames:v', '1', '-f', 'null', '-'];

/** QSV one-frame probe. On Windows QSV initialises natively (`qsv=qs`); on
 *  Linux it derives from VAAPI (see {@link qsvDeviceInitArgs}).
 *
 *  Windows transcodes run qsv-native decode + `vpp_qsv` scaling on the QSV
 *  device, so the probe drives `vpp_qsv`: its output pool is a D3D11
 *  `RENDER_TARGET` array texture — a strictly stronger allocation than a
 *  plain `hwupload` (`BIND_DECODER`) pool, and one an outdated Intel driver
 *  can reject on its own. Exercising the full filter path keeps detection
 *  honest: QSV is green-lit only when the real transcode can run. Linux QSV
 *  derives from VAAPI and scales via `scale_vaapi`→`hwmap`, so it keeps the
 *  plain upload probe. */
function qsvTest(platform: NodeJS.Platform): HwTest {
  const filter =
    platform === 'win32'
      ? 'format=nv12,hwupload,vpp_qsv=w=160:h=120:format=nv12'
      : 'hwupload,format=qsv';
  return {
    type: 'qsv',
    args: [
      '-hide_banner',
      '-loglevel',
      'error',
      ...qsvDeviceInitArgs(platform),
      '-filter_hw_device',
      'qs',
      ...BLACK_INPUT,
      '-vf',
      filter,
      '-c:v',
      'h264_qsv',
      ...ONE_FRAME_NULL,
    ],
  };
}

const VAAPI_TEST: HwTest = {
  type: 'vaapi',
  args: [
    '-hide_banner',
    '-loglevel',
    'error',
    ...vaapiDeviceInitArgs(),
    ...BLACK_INPUT,
    '-filter_hw_device',
    'va',
    '-vf',
    'format=nv12,hwupload',
    '-c:v',
    'h264_vaapi',
    ...ONE_FRAME_NULL,
  ],
};

// No -hwaccel here: this probes the AMF *encoder* only. A decode hwaccel is
// irrelevant and can conflict with the AMF device init.
const AMF_TEST: HwTest = {
  type: 'amf',
  args: [
    '-hide_banner',
    '-loglevel',
    'error',
    ...BLACK_INPUT,
    '-c:v',
    'h264_amf',
    ...ONE_FRAME_NULL,
  ],
};

const NVENC_TEST: HwTest = {
  type: 'nvenc',
  args: [
    '-hide_banner',
    '-loglevel',
    'error',
    '-hwaccel',
    'cuda',
    ...BLACK_INPUT,
    '-c:v',
    'h264_nvenc',
    ...ONE_FRAME_NULL,
  ],
};

const VIDEOTOOLBOX_TEST: HwTest = {
  type: 'videotoolbox',
  args: [
    '-hide_banner',
    '-loglevel',
    'error',
    ...BLACK_INPUT,
    '-c:v',
    'h264_videotoolbox',
    ...ONE_FRAME_NULL,
  ],
};

export async function detectHwAccel(
  log: Logger,
  platform: NodeJS.Platform = process.platform,
): Promise<HwAccelType> {
  // Per-platform probe order. macOS: VideoToolbox only. Windows: native
  // QSV → AMF → NVENC (no VAAPI). Linux: QSV → VAAPI → NVENC.
  const tests: HwTest[] =
    platform === 'darwin'
      ? [VIDEOTOOLBOX_TEST]
      : platform === 'win32'
        ? [qsvTest(platform), AMF_TEST, NVENC_TEST]
        : [qsvTest(platform), VAAPI_TEST, NVENC_TEST];

  for (const test of tests) {
    try {
      await execFileAsync('ffmpeg', test.args, { timeout: 10_000 });
      log.log(`HW accel test passed: ${test.type}`);
      return test.type;
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim();
      const tail = stderr ? stderr.split('\n').slice(-2).join(' ') : '';
      log.log(`HW accel test failed: ${test.type}${tail ? ` — ${tail}` : ''}`);
    }
  }

  return 'none';
}

/** Map the host-detected hwAccel onto the slice the orchestrator should
 *  ask the encoder registry for, applying the two pipeline-level
 *  filtering constraints:
 *
 *  - Subtitle burn-in needs CPU surfaces for libass — force `'none'`
 *    on QSV / VAAPI / NVENC. VideoToolbox decode already lands in CPU
 *    buffers so libass works in-place.
 *  - QSV cannot crop on the vaapi-decode-then-hwmap chain (the
 *    fixed-size QSV frame pool rejects the variable output of CPU
 *    `crop` after hwupload back to vaapi). When the caller indicates
 *    `qsvCanCrop=true` we stay on QSV — that flag means the caller has
 *    a qsv-native decoder + `vpp_qsv` filter path ready, which crops
 *    on the QSV device without touching vaapi pools. Without it we
 *    fall back to VAAPI like before — except on Windows, where there is
 *    no VAAPI and QSV always crops natively via `vpp_qsv`.
 *
 *  Centralised here so `ffmpeg-args` and `stream-builder` (the stats
 *  overlay path) can't drift on the rule. The registry still has the
 *  final say at resolve time. */
export function requestedHwAccelFor(
  detected: HwAccelType,
  needs: { burnIn: boolean; crop: boolean; qsvCanCrop?: boolean },
  platform: NodeJS.Platform = process.platform,
): HwAccelType {
  if (needs.burnIn && detected !== 'videotoolbox') return 'none';
  if (
    detected === 'qsv' &&
    needs.crop &&
    !needs.qsvCanCrop &&
    hostHasVaapi(platform)
  )
    return 'vaapi';
  return detected;
}
