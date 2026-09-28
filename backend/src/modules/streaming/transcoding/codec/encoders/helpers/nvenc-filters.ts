import type { EncoderInput } from '../../types';
import { scaleEvenHeight } from './scale-filter';

/** Build the `-vf` value for an 8-bit NVENC SDR encode (h264_nvenc /
 *  hevc_nvenc / av1_nvenc). NVENC encode and NVDEC decode are probed
 *  independently, so the encoder must handle whatever surface the decoder
 *  produced:
 *
 *  - `'cuda'` — NVDEC handed off GPU frames: the SDR crop+scale stays on
 *    the device with `scale_cuda`, and when `tonemap_cuda` probed the
 *    HDR→SDR tonemap stays on the surface too (no CPU bounce); otherwise it
 *    round-trips through CPU/OpenCL, so `hwdownload` pulls the frames down
 *    first.
 *  - `'cpu'` — software decode (NVDEC disabled or unable to decode this
 *    codec/bit depth): every filter runs on CPU and NVENC uploads the
 *    finished frames itself, except the `tonemap_cuda` path, which uploads
 *    explicitly to reach the CUDA-only filter.
 *  - any other HW surface (`'vaapi'` from a decode-only VAAPI stack bridged
 *    in on an NVENC host, etc.): the frames live on another device that
 *    `scale_cuda` can't touch, so `hwdownload` pulls them to system memory
 *    first.
 *
 *  Only `scale_cuda` / `hwupload_cuda` / `tonemap_cuda` require a CUDA
 *  surface; running them on non-CUDA frames aborts the graph with
 *  `Function not implemented`.
 */
export function nvencScaleFilter8bit(input: EncoderInput): string {
  const { target, filters, tonemap, hasCrop, inputSurface } = input;
  const w = target.width;
  if (tonemap && filters.tonemapCuda) {
    // Already on a CUDA surface with no crop: nothing to bounce. Otherwise
    // (CPU/VAAPI input, or a crop that ran off-GPU) land on CUDA p010le first.
    const upload =
      inputSurface === 'cuda' && !hasCrop
        ? ''
        : `${inputSurface === 'cpu' ? '' : 'hwdownload,format=p010le,'}${filters.cpuCropPrefix}format=p010le,hwupload_cuda,`;
    return `${upload}scale_cuda=w=${w}:h=-2:format=p010le${filters.tonemapCuda}`;
  }
  if (tonemap) {
    // tonemapCpu already emits `format=yuv420p`; only the download prefix
    // differs. Tonemap implies a 10-bit HDR source, so download as p010le.
    const download =
      inputSurface === 'cpu' ? '' : 'hwdownload,format=p010le,';
    return `${download}${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:${scaleEvenHeight(w)}`;
  }
  if (inputSurface === 'cuda') {
    const nvCropFilter = hasCrop
      ? `hwdownload,format=nv12,${filters.cropStr},hwupload_cuda,`
      : '';
    // scale_cuda keeps the decoder's native pixel format (no `format=`); the
    // encoder owns the output bit depth (`-profile:v main` → 8-bit). Keeping
    // format conversion out of the scaler decouples resize from pixel format.
    return `${nvCropFilter}scale_cuda=w=${w}:h=-2`;
  }
  const download = inputSurface === 'cpu' ? '' : 'hwdownload,format=nv12,';
  return `${download}${filters.cpuCropPrefix}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=yuv420p`;
}

/** Build the `-vf` value for a 10-bit NVENC HDR encode (hevc_nvenc
 *  main10, av1_nvenc hdr10 / hlg). Same surface split as the 8-bit path,
 *  but the pixels stay `p010le` end-to-end — there is no tonemap branch
 *  because a 10-bit HDR encoder is preserving HDR (tonemapping it would
 *  defeat the bitstream's HDR signaling; tonemap-to-SDR sources are routed
 *  to the 8-bit SDR rung by the registry).
 */
export function nvencScaleFilter10bit(input: EncoderInput): string {
  const { target, filters, hasCrop, inputSurface } = input;
  const w = target.width;
  if (inputSurface === 'cuda') {
    const nvCropFilter = hasCrop
      ? `hwdownload,format=p010le,${filters.cropStr},hwupload_cuda,`
      : '';
    return `${nvCropFilter}scale_cuda=w=${w}:h=-2:format=p010le`;
  }
  const download = inputSurface === 'cpu' ? '' : 'hwdownload,format=p010le,';
  return `${download}${filters.cpuCropPrefix}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=p010le`;
}
