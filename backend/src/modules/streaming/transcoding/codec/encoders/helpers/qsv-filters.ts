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
    // size in a single pass. When there's no crop, the c{w,h,x,y}
    // options default to the full input and `vpp_qsv` is a pure scale.
    const cropOpts = hasCrop && filters.cropStr
      ? // filters.cropStr is `crop=W:H:X:Y` — destructure into vpp_qsv params.
        cropStrToVppArgs(filters.cropStr)
      : '';
    return `vpp_qsv=${cropOpts}w=${w}:h=-2:format=nv12`;
  }
  if (filters.tonemapVaapi) {
    return `scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${filters.tonemapVaapi},hwmap=derive_device=qsv,format=qsv`;
  }
  if (filters.tonemapOpencl) {
    return `scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${filters.tonemapOpencl},hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv`;
  }
  return `scale_vaapi=w=${w}:h=-16:format=nv12:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv`;
}

/** Turn `'crop=W:H:X:Y'` into the `cw=W:ch=H:cx=X:cy=Y:` prefix that
 *  `vpp_qsv` accepts. */
function cropStrToVppArgs(cropStr: string): string {
  const m = cropStr.match(/^crop=(\d+):(\d+):(\d+):(\d+)$/);
  if (!m) return '';
  const [, cw, ch, cx, cy] = m;
  return `cw=${cw}:ch=${ch}:cx=${cx}:cy=${cy}:`;
}
