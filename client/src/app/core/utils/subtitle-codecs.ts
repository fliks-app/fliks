/** Bitmap subtitle codecs (PGS, VOBSUB, DVB, XSUB): images, not text, so they can't be WebVTT and must be burned in; shared by player, cast and media-detail. */
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

/** Image codecs the backend OCR pipeline can turn into text; mirrors the backend set so the UI offers extraction only where it can run. */
const OCR_SUPPORTED_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle']);

/** True for image subtitles the OCR pipeline can extract to text. */
export function isOcrSupportedSubtitleCodec(codec: string | null | undefined): boolean {
  return OCR_SUPPORTED_SUBTITLE_CODECS.has(codec ?? '');
}

/** True for ASS/SSA subtitles, by codec or, for rows without one, by file extension. */
export function isAssSubtitle(sub: {
  codec?: string | null;
  relativePath?: string | null;
}): boolean {
  return sub.codec === 'ass' || sub.codec === 'ssa' || /\.(ass|ssa)$/i.test(sub.relativePath ?? '');
}
