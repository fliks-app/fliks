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
 *  We probe TWO chains separately because some Intel iHD builds
 *  accept the tonemap-only opencl pipeline but fail the cropped
 *  variant: the extra `hwdownload → crop → hwupload=vaapi → …`
 *  prefix changes the surface format that reaches the final
 *  `hwmap=qsv:reverse=1` step and trips the bridge. Splitting the
 *  capability lets a cropped HDR session (Arcane) fall back to
 *  tonemap_vaapi while an uncropped HDR session (Mission Impossible
 *  2160p) keeps using opencl for better mid-tone restoration. */
let probedOnce = false;
let noCropEnabled = false;
let withCropEnabled = false;

/** True when tonemap_opencl can run on this host for sessions that
 *  DON'T add a CPU-side crop pass before the scale+tonemap chain. */
export function isTonemapOpenclEnabled(): boolean {
  return probedOnce && noCropEnabled;
}

/** True when tonemap_opencl can run on this host AND the extra
 *  hwdownload+crop+hwupload prefix doesn't trip the QSV↔OpenCL
 *  bridge. Stricter superset of {@link isTonemapOpenclEnabled} —
 *  always false when the basic chain failed. */
export function isTonemapOpenclEnabledWithCrop(): boolean {
  return probedOnce && withCropEnabled;
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

    // Probe 1: tonemap_opencl without the crop prefix — the path
    // session-time uses for uncropped HDR sources. Mirrors what we'd
    // run for Mission Impossible 2160p HDR no-crop / similar.
    //
    // `-filter_hw_device va` (not `ocl`): without this the hwupload
    // back to vaapi after the CPU crop fails with `Function not
    // implemented` on Intel iHD because ENOSYS bubbles up from the
    // opencl ICD when the default filter device is opencl. tonemap_
    // opencl itself runs fine — it takes its device from the
    // upstream `hwmap=derive_device=opencl` frame context.
    const baseArgs = [
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
      'va',
      '-hwaccel',
      'vaapi',
      '-hwaccel_output_format',
      'vaapi',
      '-i',
      hdrSample,
    ];
    const tail = [
      '-c:v',
      'h264_qsv',
      '-preset',
      'veryfast',
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ];
    try {
      await execFileAsync(
        'ffmpeg',
        [
          ...baseArgs,
          '-vf',
          'scale_vaapi=w=288:h=160,hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv',
          ...tail,
        ],
        { timeout: 20_000 },
      );
      noCropEnabled = true;
    } catch {
      noCropEnabled = false;
    }

    // Probe 2: crop-prefixed chain. Some Intel iHD builds accept the
    // basic chain but fail this one — `auto` then has to keep
    // cropped HDR sessions on tonemap_vaapi while uncropped sessions
    // still use opencl. Skipped when the basic chain already failed
    // (the cropped chain is a strict superset of the dependencies).
    if (noCropEnabled) {
      try {
        await execFileAsync(
          'ffmpeg',
          [
            ...baseArgs,
            '-vf',
            'hwdownload,format=p010le,crop=288:160:16:8,hwupload=derive_device=vaapi,scale_vaapi=w=288:h=160,hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv',
            ...tail,
          ],
          { timeout: 20_000 },
        );
        withCropEnabled = true;
      } catch {
        withCropEnabled = false;
      }
    }
  } finally {
    await unlink(hdrSample).catch(() => {});
    probedOnce = true;
    log.log(
      `[tonemap-opencl-probe] noCrop=${noCropEnabled} withCrop=${withCropEnabled} (${Date.now() - t0}ms)`,
    );
  }
}
