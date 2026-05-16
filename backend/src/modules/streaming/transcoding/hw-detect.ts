import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { HwAccelType } from './types';

const execFileAsync = promisify(execFile);

export async function detectHwAccel(log: Logger): Promise<HwAccelType> {
  // Priority: macOS first (VideoToolbox is the only HW path there), then
  // Linux x86 stack (QSV → VAAPI → NVENC), then CPU fallback.
  const isMac = process.platform === 'darwin';
  const tests: { type: HwAccelType; args: string[] }[] = isMac
    ? [
        {
          type: 'videotoolbox',
          args: [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'color=black:s=64x64:d=0.1',
            '-c:v',
            'h264_videotoolbox',
            '-frames:v',
            '1',
            '-f',
            'null',
            '-',
          ],
        },
      ]
    : [
        {
          type: 'qsv',
          args: [
            '-hide_banner',
            '-loglevel',
            'error',
            '-init_hw_device',
            'vaapi=va:/dev/dri/renderD128',
            '-init_hw_device',
            'qsv=qs@va',
            '-filter_hw_device',
            'qs',
            '-f',
            'lavfi',
            '-i',
            'color=black:s=64x64:d=0.1',
            '-vf',
            'hwupload=extra_hw_frames=64,format=qsv',
            '-c:v',
            'h264_qsv',
            '-frames:v',
            '1',
            '-f',
            'null',
            '-',
          ],
        },
        {
          type: 'vaapi',
          args: [
            '-hide_banner',
            '-loglevel',
            'error',
            '-init_hw_device',
            'vaapi=va:/dev/dri/renderD128',
            '-f',
            'lavfi',
            '-i',
            'color=black:s=64x64:d=0.1',
            '-filter_hw_device',
            'va',
            '-vf',
            'format=nv12,hwupload',
            '-c:v',
            'h264_vaapi',
            '-frames:v',
            '1',
            '-f',
            'null',
            '-',
          ],
        },
        {
          type: 'nvenc',
          args: [
            '-hide_banner',
            '-loglevel',
            'error',
            '-hwaccel',
            'cuda',
            '-f',
            'lavfi',
            '-i',
            'color=black:s=64x64:d=0.1',
            '-c:v',
            'h264_nvenc',
            '-frames:v',
            '1',
            '-f',
            'null',
            '-',
          ],
        },
      ];

  for (const test of tests) {
    try {
      await execFileAsync('ffmpeg', test.args, { timeout: 10_000 });
      log.log(`HW accel test passed: ${test.type}`);
      return test.type;
    } catch {
      log.log(`HW accel test failed: ${test.type}`);
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
 *  - QSV cannot crop on the legacy vaapi-decode-then-hwmap chain (the
 *    fixed-size QSV frame pool rejects the variable output of CPU
 *    `crop` after hwupload back to vaapi). When the caller indicates
 *    `qsvCanCrop=true` we stay on QSV — that flag means the caller has
 *    a qsv-native decoder + `vpp_qsv` filter path ready, which crops
 *    on the QSV device without touching vaapi pools. Without it we
 *    fall back to VAAPI like before.
 *
 *  Centralised here so `ffmpeg-args` and `stream-builder` (the stats
 *  overlay path) can't drift on the rule. The registry still has the
 *  final say at resolve time. */
export function requestedHwAccelFor(
  detected: HwAccelType,
  needs: { burnIn: boolean; crop: boolean; qsvCanCrop?: boolean },
): HwAccelType {
  if (needs.burnIn && detected !== 'videotoolbox') return 'none';
  if (detected === 'qsv' && needs.crop && !needs.qsvCanCrop) return 'vaapi';
  return detected;
}
