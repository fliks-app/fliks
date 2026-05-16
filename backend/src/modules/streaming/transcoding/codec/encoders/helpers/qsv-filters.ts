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
  const { target, filters, hasCrop } = input;
  const w = target.width;
  if (input.inputSurface === 'qsv') {
    // crop_qsv + scale_qsv in one filter. `vpp_qsv` is the libavfilter
    // wrapper over Intel VPP and accepts both crop region and output
    // size in a single pass. Unlike software `scale=W:-2`, vpp_qsv
    // requires explicit integer h — compute it from the crop's aspect
    // (or the rung's profile maxHeight when there's no crop) snapped
    // to mod-2 so the encoder doesn't reject odd luma height.
    const cropArgs =
      hasCrop && filters.cropStr ? parseCropStr(filters.cropStr) : null;
    const targetH = cropArgs
      ? snapEven(Math.round((w * cropArgs.h) / cropArgs.w))
      : target.height;
    const cropOpts = cropArgs
      ? `cw=${cropArgs.w}:ch=${cropArgs.h}:cx=${cropArgs.x}:cy=${cropArgs.y}:`
      : '';
    return `vpp_qsv=${cropOpts}w=${w}:h=${targetH}:format=nv12`;
  }
  // hwCropPrefix = 'hwdownload,format=nv12,crop=…,hwupload=vaapi,' when
  // a crop is needed and we're on the vaapi-input path. Prepending it
  // lets scale_vaapi rebuild a fresh fixed-size pool from the cropped
  // CPU frames — the QSV hwmap downstream then accepts the surfaces
  // (the 'fixed-size pool' rejection only fires when the pool changes
  // size mid-chain, which scale_vaapi avoids by reallocating).
  if (filters.tonemapVaapi) {
    return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${filters.tonemapVaapi},hwmap=derive_device=qsv,format=qsv`;
  }
  if (filters.tonemapOpencl) {
    return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${filters.tonemapOpencl},hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv`;
  }
  return `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-16:format=nv12:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv`;
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
