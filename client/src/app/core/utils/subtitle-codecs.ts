/**
 * Bitmap subtitle codecs (PGS, VOBSUB, DVB, XSUB). They carry rendered images,
 * not text, so they can't be served as WebVTT and must be burned into the video.
 * Single source of truth so the player, cast and media-detail surfaces agree.
 */
const IMAGE_BASED_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'dvb_subtitle',
  'xsub',
]);

/** True for bitmap subtitles that need burn-in. */
export function isImageBasedSubtitleCodec(codec: string | null | undefined): boolean {
  return IMAGE_BASED_SUBTITLE_CODECS.has(codec ?? '');
}
