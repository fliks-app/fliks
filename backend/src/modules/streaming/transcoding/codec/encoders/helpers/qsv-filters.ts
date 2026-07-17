import type { EncoderInput } from '../../types';

/** Build the `-vf` value for an 8-bit QSV encode (h264_qsv / hevc_qsv).
 *  Branches on what we received from the decoder:
 *
 *  - `inputSurface === 'qsv'` (qsv-native decoder, no tonemap): use
 *    `vpp_qsv` for crop + scale + format on the QSV device. End-to-end
 *    QSV pipeline, no hwmap, no fixed-pool quirk on crop.
 *  - tonemapVaapi: keep on VAAPI surfaces, tonemap on the VPP (1 device).
 *  - tonemapOpencl: reinhard via OpenCL, then hwmap to QSV.
 *  - default (vaapi surfaces, no tonemap): scale_vaapi → hwmap to QSV.
 *
 *  scale_vaapi is preferred over scale_qsv for the vaapi-input paths
 *  because libva exposes more scaling-quality knobs (`extra_hw_frames`,
 *  native nv12 output) on every gen we care about. */
export function qsvScaleFilter8bit(input: EncoderInput): string {
  const { target, filters, hasCrop, tonemap, tonemapPath } = input;
  const w = target.width;
  if (input.inputSurface === 'qsv' || input.inputSurface === 'd3d11') {
    // Windows decodes on D3D11VA and hands the frame here as a `d3d11`
    // surface; map it onto the QSV device before `vpp_qsv`. A Linux qsv-native
    // input is already a QSV surface, so the prefix is empty.
    const qsvMap =
      input.inputSurface === 'd3d11' ? 'hwmap=derive_device=qsv,' : '';
    // `vpp_qsv` does crop + scale + format on the QSV device in one
    // pass — no CPU bounce, no hwmap. Tonemap is wired three ways:
    //  - `tonemap=qsv`: enable vpp_qsv's fixed-function HDR LUT
    //    (`tonemap=1`), output nv12 directly. Fastest path but the
    //    Intel VPP LUT under-exposes on some iGPUs, hence the admin
    //    override.
    //  - `tonemap=opencl`: vpp_qsv outputs p010le (HDR preserved),
    //    then hwmap → opencl, reinhard tonemap, hwmap back to qsv,
    //    `format=qsv`. Two hwmaps but no CPU traffic — measured at
    //    ~3× the throughput of the vaapi-decode chain on cropped 4K
    //    HDR sources, with identical visual output.
    //  - no tonemap (crop/scale only) — straight nv12 output.
    const cropArgs =
      hasCrop && filters.cropStr ? parseCropStr(filters.cropStr) : null;
    const targetH = cropArgs
      ? snapEven(Math.round((w * cropArgs.h) / cropArgs.w))
      : target.height;
    const cropOpts = cropArgs
      ? `cw=${cropArgs.w}:ch=${cropArgs.h}:cx=${cropArgs.x}:cy=${cropArgs.y}:`
      : '';
    if (tonemap && tonemapPath === 'opencl') {
      if (input.inputSurface === 'd3d11') {
        // Windows: no zero-copy QSV↔OpenCL bridge (D3D11↔OpenCL is NV12-only,
        // can't carry the 10-bit HDR surface). Scale on the QSV VPP (p010),
        // bounce through CPU into OpenCL for the tone-map, hand nv12 back to
        // the encoder (which auto-uploads to the QSV device).
        return (
          `hwmap=derive_device=qsv,vpp_qsv=${cropOpts}w=${w}:h=${targetH}:format=p010le,` +
          `hwdownload,format=p010le,hwupload,` +
          `tonemap_opencl=tonemap=hable:t=bt709:m=bt709:p=bt709:format=nv12,` +
          `hwdownload,format=nv12`
        );
      }
      return (
        `vpp_qsv=${cropOpts}w=${w}:h=${targetH}:format=p010le,` +
        `hwmap=derive_device=opencl:mode=read,` +
        `tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,` +
        `hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,` +
        `format=qsv`
      );
    }
    const tonemapOpt = tonemap ? 'tonemap=1:' : '';
    return `${qsvMap}vpp_qsv=${tonemapOpt}${cropOpts}w=${w}:h=${targetH}:format=nv12`;
  }
  // hwCropPrefix = 'hwdownload,format=nv12,crop=…,hwupload=vaapi,' when
  // a crop is needed and we're on the vaapi-input path. Prepending it
  // lets scale_vaapi rebuild a fresh fixed-size pool from the cropped
  // CPU frames — the QSV hwmap downstream then accepts the surfaces
  // (the 'fixed-size pool' rejection only fires when the pool changes
  // size mid-chain, which scale_vaapi avoids by reallocating).
  if (filters.tonemapVaapi) {
    return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapVaapi},hwmap=derive_device=qsv,format=qsv`;
  }
  if (filters.tonemapOpencl) {
    return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapOpencl},hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv`;
  }
  return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:format=nv12:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv`;
}

/** Build the `-vf` value for a 10-bit QSV encode (hevc_qsv main10,
 *  av1_qsv hdr10). Same shape as {@link qsvScaleFilter8bit} but the
 *  HW surfaces stay in `p010le` and there are no tonemap branches —
 *  the encoder is producing HDR, so a tonemap would defeat the
 *  bitstream's HDR signaling. Tonemap-to-SDR HDR sources never reach
 *  a 10-bit HDR encoder; the registry routes them to an SDR rung
 *  with the matching 8-bit descriptor. */
export function qsvScaleFilter10bit(input: EncoderInput): string {
  const { target, filters, hasCrop } = input;
  const w = target.width;
  if (input.inputSurface === 'qsv' || input.inputSurface === 'd3d11') {
    // See qsvScaleFilter8bit: Windows d3d11 input maps onto the QSV device
    // first; Linux qsv-native input is already a QSV surface.
    const qsvMap =
      input.inputSurface === 'd3d11' ? 'hwmap=derive_device=qsv,' : '';
    const cropArgs =
      hasCrop && filters.cropStr ? parseCropStr(filters.cropStr) : null;
    const targetH = cropArgs
      ? snapEven(Math.round((w * cropArgs.h) / cropArgs.w))
      : target.height;
    const cropOpts = cropArgs
      ? `cw=${cropArgs.w}:ch=${cropArgs.h}:cx=${cropArgs.x}:cy=${cropArgs.y}:`
      : '';
    return `${qsvMap}vpp_qsv=${cropOpts}w=${w}:h=${targetH}:format=p010le`;
  }
  return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:format=p010le:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv`;
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

function snapEven(n: number): number {
  return n - (n % 2);
}
