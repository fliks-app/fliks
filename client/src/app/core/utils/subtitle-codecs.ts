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

/**
 * Image codecs the backend OCR pipeline can turn into text (PGS, VOBSUB).
 * Mirrors the backend set so the UI only offers extraction where it can run.
 */
const OCR_SUPPORTED_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle']);

/** True for image subtitles the OCR pipeline can extract to text. */
export function isOcrSupportedSubtitleCodec(codec: string | null | undefined): boolean {
  return OCR_SUPPORTED_SUBTITLE_CODECS.has(codec ?? '');
}
