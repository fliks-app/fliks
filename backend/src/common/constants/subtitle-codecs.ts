/**
 * Bitmap subtitle codecs. These carry rendered images rather than text, so
 * they can't be served as WebVTT/SRT and must be burned into the video to be
 * shown — or OCR'd to text first. Kept in one place so detection, burn-in and
 * the OCR pipeline can't drift apart.
 */
export const IMAGE_BASED_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'dvb_subtitle',
  'xsub',
]);

/** True for bitmap subtitles (PGS, VOBSUB, DVB, XSUB) that need burn-in. */
export function isImageBasedSubtitleCodec(codec: string | null | undefined): boolean {
  return IMAGE_BASED_SUBTITLE_CODECS.has(codec ?? '');
}
