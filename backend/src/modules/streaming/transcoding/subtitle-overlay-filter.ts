import type { HwAccelType } from './types';

/**
 * Image-based subtitle burn-in (PGS / VOBSUB). Text subtitles are rendered into
 * the encoder's `-vf` chain by libass; bitmap subtitles must be composited with
 * an `overlay` filter, which needs a second filtergraph input and therefore
 * `-filter_complex`.
 *
 * Strategy: reuse the encoder's `-vf` chain unchanged (so the accelerated
 * scale + HDR tone-map survive on the GPU) and only append the overlay. To keep
 * decode/scale/tonemap/encode on the GPU, the frame is round-tripped to the CPU
 * just for the composite (`hwdownload` → CPU `overlay` → `hwupload` back). The
 * 8-bit SDR path composites in RGB (so the blend doesn't run through the
 * video's limited-range YUV matrix) and brightens the typically-grey PGS fill
 * toward white for readability; the 10-bit path composites in YUV (p010le) — no
 * 8-bit RGB round-trip that would crush HDR, and no whitening (meaningless in
 * HDR). Output pad: `[vout]`.
 */
export function buildImageBurnInFilterComplex(ctx: {
  hwAccel: HwAccelType;
  /** The encoder's `-vf` chain (scale + optional crop/tonemap + format). */
  videoFilter: string;
  /** Absolute container index of the bitmap subtitle stream. */
  streamIndex: number;
  /** Target output dimensions (matches the video chain's output). */
  width: number;
  height: number;
  /** Output bit depth — picks the HW surface / pixel formats (8 vs 10 bit). */
  bitDepth: number;
  /** Letterbox crop applied to the video, in source pixels. The PGS overlay is
   *  authored against the full source frame, so it must be cropped identically
   *  before scaling or the subtitle ends up oversized and mispositioned. */
  crop?: { width: number; height: number; x: number; y: number };
}): string {
  const { hwAccel, videoFilter, streamIndex: s, width: w, height: h, crop } = ctx;
  const tenBit = ctx.bitDepth >= 10;
  const video = videoFilter ? `[0:v]${videoFilter}` : '[0:v]null';

  // Scale the subtitle (positioned against the source frame) to the output
  // size so the overlay lines up; keep its alpha. SDR: pull the grey fill up to
  // white (dark outline stays black). HDR: leave it untouched.
  const whiten = tenBit ? '' : ',colorlevels=rimax=0.6:gimax=0.6:bimax=0.6';
  const subCrop = crop
    ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},`
    : '';
  const sub = `[0:${s}]${subCrop}scale=${w}:${h}:flags=lanczos,format=rgba${whiten}[s]`;

  const hwFmt = tenBit ? 'p010le' : 'nv12';

  // CPU encode paths (libx264/libx265, VideoToolbox) already hand CPU frames —
  // no device round-trip.
  if (hwAccel === 'none' || hwAccel === 'videotoolbox') {
    if (tenBit) {
      return `${video}[v];${sub};[v][s]overlay[vout]`;
    }
    return (
      `${video},format=rgb24[v];${sub};[v][s]overlay[ov];[ov]format=yuv420p[vout]`
    );
  }

  // HW encode paths: the chain ends on a GPU surface. Round-trip to CPU just
  // for the composite, then re-upload to the encoder's device.
  const upload =
    hwAccel === 'nvenc' ? 'hwupload_cuda' : 'hwupload=extra_hw_frames=16';
  if (tenBit) {
    return (
      `${video},hwdownload,format=${hwFmt}[v];` +
      `${sub};` +
      `[v][s]overlay[ov];` +
      `[ov]format=${hwFmt},${upload}[vout]`
    );
  }
  return (
    `${video},hwdownload,format=${hwFmt},format=rgb24[v];` +
    `${sub};` +
    `[v][s]overlay[ov];` +
    `[ov]format=${hwFmt},${upload}[vout]`
  );
}
