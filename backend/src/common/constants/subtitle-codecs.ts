import { SubtitleStatus } from '../enums';

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

/**
 * Image codecs the OCR pipeline can actually turn into text: PGS via pgsrip,
 * VOBSUB (dvd_subtitle) via mkvextract + subtile-ocr. DVB and XSUB are bitmap
 * but have no OCR path, so extraction must not be offered for them.
 */
export const OCR_SUPPORTED_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
]);

/** True for image subtitles the OCR pipeline can extract to text. */
export function isOcrSupportedSubtitleCodec(codec: string | null | undefined): boolean {
  return OCR_SUPPORTED_SUBTITLE_CODECS.has(codec ?? '');
}

/** Minimal subtitle shape needed to decide whether a language is covered. */
export interface ServableSubProbe {
  language: string;
  codec?: string | null;
  status?: SubtitleStatus | null;
}

/**
 * A profile language is satisfied only by a servable TEXT subtitle: an
 * image-based track is burn-in/OCR material, and a FAILED row never counts.
 * Shared so the post-import, missing-search and missing-list paths agree.
 */
export function hasServableTextSub(
  subs: ServableSubProbe[],
  isoCode: string,
): boolean {
  return subs.some(
    (s) =>
      s.language === isoCode &&
      !isImageBasedSubtitleCodec(s.codec) &&
      s.status !== SubtitleStatus.FAILED,
  );
}
