import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import { promisify } from 'util';
import { findQsvNativeDecoder } from './decoders';
import { hevcVaapiDecoder } from './decoders/vaapi';
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
let hdr10Enabled = false;

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

/** True when the `apply_dovi=1` HDR10-target reshape runs on this bridge,
 *  distinct from the SDR nv12 recipe above (no `apply_dovi`). */
export function isTonemapOpenclHdr10Enabled(): boolean {
  return probedOnce && hdr10Enabled;
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

    // The real decoder descriptor, so `-filter_hw_device` (`qs` on QSV, `va`
    // on VAAPI) can't drift from what a session actually runs.
    const decoder = hwAccel === 'qsv' ? findQsvNativeDecoder('hevc')! : hevcVaapiDecoder;
    const baseArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      ...decoder.buildInputArgs(),
      '-init_hw_device',
      'opencl=ocl:0.0',
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
          `scale_vaapi=w=288:h=160:extra_hw_frames=24,hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,${reverseMap}`,
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
            `hwdownload,format=p010le,crop=288:160:16:8,hwupload=derive_device=vaapi,scale_vaapi=w=288:h=160:extra_hw_frames=24,hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,${reverseMap}`,
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

    // Probe 3: the HDR10-target reshape (`apply_dovi=1`, PQ/BT.2020) a
    // no-base DV session emits instead; hevc10 so the p010 surface is real.
    if (noCropEnabled) {
      try {
        await execFileAsync(
          'ffmpeg',
          [
            ...baseArgs,
            '-vf',
            `scale_vaapi=w=288:h=160:extra_hw_frames=24,hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=p010:t=smpte2084:p=bt2020:m=bt2020:r=tv:apply_dovi=1,${reverseMap}`,
            '-c:v',
            hwAccel === 'qsv' ? 'hevc_qsv' : 'hevc_vaapi',
            '-profile:v',
            'main10',
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
        hdr10Enabled = true;
      } catch (err) {
        hdr10Enabled = false;
        failure = ffmpegTail(err);
      }
    }
  } catch (err) {
    failure = ffmpegTail(err) || (err as Error).message;
  } finally {
    await unlink(hdrSample).catch(() => {});
    probedOnce = true;
    log.log(
      `[tonemap-opencl-probe] noCrop=${noCropEnabled} withCrop=${withCropEnabled} hdr10=${hdr10Enabled} (${Date.now() - t0}ms)${failure ? `: ${failure}` : ''}`,
    );
  }
}
