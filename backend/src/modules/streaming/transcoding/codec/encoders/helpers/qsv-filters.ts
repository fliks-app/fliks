import type { EncoderInput } from '../../types';
import { dvApplyDoviOpt } from '../../../ffmpeg-filter-graph';

/** No decoder emits a literal qsv surface: both platforms decode natively,
 *  elsewhere, so `vpp_qsv` always needs this hwmap first. */
const QSV_HWMAP = 'hwmap=derive_device=qsv,';

/** vpp_qsv crop options for the qsv-native/d3d11 branch of both bit-depth
 *  filter builders below. */
function qsvCropOpts(input: EncoderInput): string {
  const cropArgs =
    input.hasCrop && input.filters.cropStr ? parseCropStr(input.filters.cropStr) : null;
  return cropArgs
    ? `cw=${cropArgs.w}:ch=${cropArgs.h}:cx=${cropArgs.x}:cy=${cropArgs.y}:`
    : '';
}

/** Build the `-vf` value for an 8-bit QSV encode (h264_qsv / hevc_qsv).
 *  Branches on what we received from the decoder:
 *
 *  - `inputSurface === 'qsv'` (qsv-native decoder, no tonemap): hwmap onto
 *    QSV, then `vpp_qsv` for crop + scale + format, no fixed-pool quirk on crop.
 *  - tonemapVaapi: keep on VAAPI surfaces, tonemap on the VPP (1 device).
 *  - tonemapOpencl: the admin curve via OpenCL, then hwmap to QSV.
 *  - default (vaapi surfaces, no tonemap): scale_vaapi → hwmap to QSV.
 *
 *  scale_vaapi is preferred over scale_qsv for the vaapi-input paths
 *  because libva exposes more scaling-quality knobs (`extra_hw_frames`,
 *  native nv12 output) on every gen we care about. */
export function qsvScaleFilter8bit(input: EncoderInput): string {
  const { target, filters, tonemap, tonemapPath, dvNoBase } = input;
  const w = target.width;
  const curve = input.tonemapCurve ?? 'hable';
  if (input.inputSurface === 'qsv' || input.inputSurface === 'd3d11') {
    // Both decode natively (VAAPI on Linux, D3D11VA on Windows), so the
    // frame always needs the hwmap before `vpp_qsv` runs.
    const cropOpts = qsvCropOpts(input);
    if (tonemap && tonemapPath === 'opencl') {
      if (input.inputSurface === 'd3d11') {
        // Windows zero-copy: vpp_qsv scale (p010, HDR kept) can't ingest a
        // reverse-mapped OpenCL surface, so the scale precedes the OpenCL step.
        return (
          `${QSV_HWMAP}vpp_qsv=${cropOpts}w=${w}:h=${target.height}:format=p010le,` +
          `hwmap=derive_device=opencl,` +
          `tonemap_opencl=tonemap=${curve}:t=bt709:m=bt709:p=bt709:format=nv12:${dvApplyDoviOpt(dvNoBase)},` +
          `hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv`
        );
      }
      return (
        `${QSV_HWMAP}vpp_qsv=${cropOpts}w=${w}:h=${target.height}:format=p010le,` +
        `hwmap=derive_device=opencl:mode=read,` +
        `tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=${curve}:desat=0:${dvApplyDoviOpt(dvNoBase)},` +
        `hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,` +
        `format=qsv`
      );
    }
    const tonemapOpt = tonemap ? 'tonemap=1:' : '';
    return `${QSV_HWMAP}vpp_qsv=${tonemapOpt}${cropOpts}w=${w}:h=${target.height}:format=nv12`;
  }
  // CPU frames crop in place, then upload to VAAPI: `derive_device` is needed
  // because the default filter device is qs, which scale_vaapi rejects.
  const isCpu = input.inputSurface === 'cpu';
  const cropPrefix = isCpu ? filters.cpuCropPrefix : filters.hwCropPrefix;
  // p010le keeps 10-bit precision for a following tonemap.
  const cpuUploadFmt = filters.tonemapVaapi || filters.tonemapOpencl ? 'p010le' : 'nv12';
  const cpuUpload = isCpu ? `format=${cpuUploadFmt},hwupload=derive_device=vaapi,` : '';
  // Text burn-in bounces to CPU only for `subtitles=...`, then re-uploads.
  // The qsv-native branch above never runs with burn-in, so only this needs it.
  const burnInTail = input.hasBurnIn
    ? `,hwdownload,format=nv12${filters.burnInFilter},hwupload=extra_hw_frames=16`
    : '';
  if (filters.tonemapVaapi) {
    // Burn-in bounces to CPU right after anyway, so skip the vpp_qsv
    // re-render and hwdownload straight off the VAAPI surface.
    if (input.hasBurnIn) {
      return `${cropPrefix}${cpuUpload}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapVaapi}${burnInTail}`;
    }
    // tonemap_vaapi does not output a QSV-native surface: passthrough=0 makes
    // vpp_qsv re-render it into one the encoder accepts.
    return `${cropPrefix}${cpuUpload}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapVaapi},hwmap=derive_device=qsv,vpp_qsv=format=nv12:passthrough=0`;
  }
  if (filters.tonemapOpencl) {
    return `${cropPrefix}${cpuUpload}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapOpencl},hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv${burnInTail}`;
  }
  return `${cropPrefix}${cpuUpload}scale_vaapi=w=${w}:h=-2:format=nv12:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv${burnInTail}`;
}

/** Build the `-vf` value for a 10-bit QSV encode (hevc_qsv main10,
 *  av1_qsv hdr10). Same shape as {@link qsvScaleFilter8bit} but the
 *  HW surfaces stay in `p010le` and there is normally no tonemap
 *  branch; the encoder is producing HDR, so a tonemap would defeat
 *  the bitstream's HDR signaling. The one exception is a no-base DV
 *  source reshaped into HDR10 (see dvNoBaseHdr10Eligible): tonemap
 *  is on and `tonemapPath === 'opencl'` runs the RPU-aware bounce. */
export function qsvScaleFilter10bit(input: EncoderInput): string {
  const { target, filters, tonemap, tonemapPath, dvNoBase } = input;
  const w = target.width;
  if (input.inputSurface === 'qsv' || input.inputSurface === 'd3d11') {
    // See qsvScaleFilter8bit: both surfaces need the hwmap onto QSV first.
    const cropOpts = qsvCropOpts(input);
    if (tonemap && tonemapPath === 'opencl') {
      if (input.inputSurface === 'd3d11') {
        return (
          `${QSV_HWMAP}vpp_qsv=${cropOpts}w=${w}:h=${target.height}:format=p010le,` +
          `hwmap=derive_device=opencl,` +
          `tonemap_opencl=t=smpte2084:m=bt2020:p=bt2020:r=tv:format=p010:${dvApplyDoviOpt(dvNoBase)},` +
          `hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv`
        );
      }
      return (
        `${QSV_HWMAP}vpp_qsv=${cropOpts}w=${w}:h=${target.height}:format=p010le,` +
        `hwmap=derive_device=opencl:mode=read,` +
        `tonemap_opencl=format=p010:p=bt2020:t=smpte2084:m=bt2020:r=tv:${dvApplyDoviOpt(dvNoBase)},` +
        `hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,` +
        `format=qsv`
      );
    }
    return `${QSV_HWMAP}vpp_qsv=${cropOpts}w=${w}:h=${target.height}:format=p010le`;
  }
  const isCpu = input.inputSurface === 'cpu';
  const cropPrefix = isCpu ? filters.cpuCropPrefix : filters.hwCropPrefix;
  const cpuUpload = isCpu ? 'format=p010le,hwupload=derive_device=vaapi,' : '';
  const burnInTail = input.hasBurnIn
    ? `,hwdownload,format=p010le${filters.burnInFilter},hwupload=extra_hw_frames=16`
    : '';
  if (filters.tonemapOpencl) {
    return `${cropPrefix}${cpuUpload}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapOpencl},hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv${burnInTail}`;
  }
  return `${cropPrefix}${cpuUpload}scale_vaapi=w=${w}:h=-2:format=p010le:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv${burnInTail}`;
}

function parseCropStr(
  cropStr: string,
): { w: number; h: number; x: number; y: number } | null {
  const m = cropStr.match(/^crop=(\d+):(\d+):(\d+):(\d+)$/);
  if (!m) return null;
  return {
    w: parseInt(m[1], 10),
    h: parseInt(m[2], 10),
    x: parseInt(m[3], 10),
    y: parseInt(m[4], 10),
  };
}

