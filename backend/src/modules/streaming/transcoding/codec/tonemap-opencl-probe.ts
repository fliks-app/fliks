import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Result of the tonemap_opencl capability probe. OpenCL HDR→SDR
 *  tonemapping requires (a) `libOpenCL.so` available to ffmpeg, (b) a
 *  platform driver registered with the ICD loader (Intel
 *  `intel-opencl-icd`, NVIDIA `nvidia-opencl-icd`, …), AND (c) a
 *  working QSV↔OpenCL bridge — some Intel hosts report
 *  `QSV to OpenCL mapping not usable` and the encoder crashes with
 *  exit=218 mid-segment. macOS is also a no-go (Apple deprecated
 *  OpenCL in 10.14 and ffmpeg-on-mac drops it more often than not).
 *
 *  We probe it once at boot rather than whitelisting hosts: a one-shot
 *  real-world run of the same filter graph we'd use at session time is
 *  the only thing that catches all three failure modes at once.
 *
 *  The flag gates the `tonemapAlgo='auto'` default in `ffmpeg-args`:
 *  when opencl is functional we route HDR→SDR through tonemap_opencl
 *  (better mid-tone restoration on Intel iGPUs whose fixed-function
 *  VPP HDR LUT under-exposes); when it isn't, we fall back to
 *  tonemap_vaapi. The admin override stays available either way. */
let probedOnce = false;
let enabled = false;

export function isTonemapOpenclEnabled(): boolean {
  return probedOnce && enabled;
}

export async function runTonemapOpenclProbe(log: Logger): Promise<void> {
  const t0 = Date.now();
  const hdrSample = path.join(
    os.tmpdir(),
    `fliks-tonemap-opencl-probe-${process.pid}.hevc`,
  );
  try {
    // Same synthesised HEVC Main10 PQ source as the vpp_qsv probe —
    // black frames are fine, we're checking filter-graph plumbing.
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

    // Mirror the production tonemap_opencl chain: VAAPI decode →
    // scale_vaapi → hwmap to OpenCL → tonemap_opencl → hwmap back to
    // QSV → h264_qsv encode. Exit 0 = libOpenCL is loadable, the
    // platform driver registers, and the QSV↔OpenCL bridge survives a
    // full decode→encode round-trip.
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-init_hw_device',
        'vaapi=va:/dev/dri/renderD128',
        '-init_hw_device',
        'qsv=qs@va',
        '-init_hw_device',
        'opencl=ocl:0.0',
        '-filter_hw_device',
        'ocl',
        '-hwaccel',
        'vaapi',
        '-hwaccel_output_format',
        'vaapi',
        '-i',
        hdrSample,
        '-vf',
        'scale_vaapi=w=320:h=176:format=p010le,hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv',
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
      { timeout: 20_000 },
    );
    enabled = true;
  } catch {
    enabled = false;
  } finally {
    await unlink(hdrSample).catch(() => {});
    probedOnce = true;
    log.log(
      `[tonemap-opencl-probe] ${enabled ? 'enabled' : 'disabled'} (${Date.now() - t0}ms)`,
    );
  }
}
