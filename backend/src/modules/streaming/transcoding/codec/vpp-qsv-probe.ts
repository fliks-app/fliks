import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { qsvDeviceInitArgs } from '../hw-device';

const execFileAsync = promisify(execFile);

/** Result of the vpp_qsv tonemap capability probe. The fixed-function
 *  HDR tone-mapping unit only exists on Intel iGPUs/dGPUs from Tiger
 *  Lake (gen11) onwards — Skylake / Kaby / Coffee / Comet / Ice Lake
 *  ship VPP but no HDR LUT. We probe it once at boot rather than
 *  whitelisting CPU generations: a real one-frame run is more reliable
 *  than parsing /sys/devices output, and it also catches the few
 *  driver releases where Init succeeds but the encoder later rejects
 *  the surfaces.
 *
 *  The flag is queried by `qsvScaleFilter8bit` (and the HDR encoder
 *  filter chains) to decide between the upstream `vpp_qsv=tonemap=1`
 *  single-pass HDR→SDR path and the `hwmap+tonemap_vaapi+hwmap`
 *  fallback. */
let probedOnce = false;
let enabled = false;

export function isVppQsvTonemapEnabled(): boolean {
  return probedOnce && enabled;
}

export async function runVppQsvTonemapProbe(log: Logger): Promise<void> {
  const t0 = Date.now();
  const hdrSample = path.join(
    os.tmpdir(),
    `fliks-vpp-qsv-tonemap-probe-${process.pid}.hevc`,
  );
  try {
    // Synthesise a tiny 8-frame HEVC Main10 HDR bitstream with PQ tags
    // and a baseline mastering-display SEI — enough metadata for
    // `vpp_qsv tonemap=1` to engage the HDR path. `nullsrc` produces
    // black frames, which is what we want (we're testing the filter
    // graph plumbing, not visual fidelity).
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

    // Decode the sample on QSV-native, run vpp_qsv tonemap, encode 1
    // frame with h264_qsv. Exit 0 = the HW path is real and functional.
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        ...qsvDeviceInitArgs(),
        '-filter_hw_device',
        'qs',
        '-hwaccel',
        'qsv',
        '-hwaccel_output_format',
        'qsv',
        '-i',
        hdrSample,
        '-vf',
        'vpp_qsv=tonemap=1:w=320:h=176:format=nv12',
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
      `[vpp-qsv-tonemap-probe] ${enabled ? 'enabled' : 'disabled'} (${Date.now() - t0}ms)`,
    );
  }
}
