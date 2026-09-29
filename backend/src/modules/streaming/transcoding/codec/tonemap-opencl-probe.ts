import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import { promisify } from 'util';
import { qsvDeviceInitArgs, vaapiDeviceInitArgs } from '../hw-device';
import { synthesiseHdrProbeSample } from './hdr-probe-sample';
import { ffmpegTail, probeSamplePath } from './probe-utils';

const execFileAsync = promisify(execFile);

/** Whether `tonemap_opencl` works on this host's VAAPI↔OpenCL bridge, probed
 *  both without and with a CPU-side crop prefix — some Intel iHD builds
 *  accept one chain but not the other, so an uncropped HDR session can use
 *  opencl while a cropped one falls back to tonemap_vaapi. */
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

export async function runTonemapOpenclProbe(
  log: Logger,
  hwAccel: 'qsv' | 'vaapi',
): Promise<void> {
  const t0 = Date.now();
  let failure = '';
  const hdrSample = probeSamplePath('tonemap-opencl');
  try {
    await synthesiseHdrProbeSample(hdrSample);

    // Device init matches the session: a QSV host adds `qsv=qs@va`, a VAAPI
    // host has no QSV device at all.
    //
    // `-filter_hw_device va` (not `ocl`): without this the hwupload back to
    // vaapi after the CPU crop fails with `Function not implemented` on
    // Intel iHD because ENOSYS bubbles up from the opencl ICD when the
    // default filter device is opencl. tonemap_opencl itself runs fine — it
    // takes its device from the upstream `hwmap=derive_device=opencl` frame
    // context.
    const baseArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      ...(hwAccel === 'qsv' ? qsvDeviceInitArgs() : vaapiDeviceInitArgs()),
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
    // Same tail as the session: QSV maps back onto QSV (qsv-filters.ts),
    // VAAPI stays on VAAPI (vaapi-filters.ts).
    const reverseMap =
      hwAccel === 'qsv'
        ? 'hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv'
        : 'hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi';
    const tail = [
      '-c:v',
      hwAccel === 'qsv' ? 'h264_qsv' : 'h264_vaapi',
      '-preset',
      'veryfast',
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ];
    // Probe 1: tonemap_opencl without the crop prefix — the path
    // session-time uses for uncropped HDR sources.
    try {
      await execFileAsync(
        'ffmpeg',
        [
          ...baseArgs,
          '-vf',
          `scale_vaapi=w=288:h=160,hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,${reverseMap}`,
          ...tail,
        ],
        { timeout: 20_000 },
      );
      noCropEnabled = true;
    } catch (err) {
      noCropEnabled = false;
      failure = ffmpegTail(err);
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
            `hwdownload,format=p010le,crop=288:160:16:8,hwupload=derive_device=vaapi,scale_vaapi=w=288:h=160,hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,${reverseMap}`,
            ...tail,
          ],
          { timeout: 20_000 },
        );
        withCropEnabled = true;
      } catch (err) {
        withCropEnabled = false;
        failure = ffmpegTail(err);
      }
    }
  } catch (err) {
    failure = ffmpegTail(err) || (err as Error).message;
  } finally {
    await unlink(hdrSample).catch(() => {});
    probedOnce = true;
    log.log(
      `[tonemap-opencl-probe] noCrop=${noCropEnabled} withCrop=${withCropEnabled} (${Date.now() - t0}ms)${failure ? `: ${failure}` : ''}`,
    );
  }
}
