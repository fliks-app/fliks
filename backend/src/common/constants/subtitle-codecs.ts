import { SubtitleStatus } from '../enums';
import {
  SubtitleFlagsProbe,
  SubtitleLanguageItem,
  matchesRequestedFlags,
  requestFlagsOf,
} from './subtitle-flags';

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
export interface ServableSubProbe extends SubtitleFlagsProbe {
  language: string;
  codec?: string | null;
  status?: SubtitleStatus | null;
}

export interface CoverageOptions {
  /** Count an image track as covering the language. It is only playable via
   *  burn-in, which forces a transcode on every session — off by default,
   *  behind `subtitle_burn_in_covers_language`. */
  imageTracksCount?: boolean;
}

/**
 * A profile language item is satisfied only by a servable subtitle carrying
 * the flags it asks for: a FAILED row never counts, a forced track never
 * covers a full-subtitle request (nor the reverse), and an image track counts
 * only when the caller accepts burn-in. Shared so the post-import,
 * missing-search and missing-list paths agree.
 */
export function hasCoveringSub(
  subs: ServableSubProbe[],
  item: SubtitleLanguageItem,
  opts: CoverageOptions = {},
): boolean {
  // Only `forced` decides coverage. The HI mode picks what to fetch, and a
  // stored row can legitimately carry the opposite flag — cleaning the HI cues
  // clears it — so enforcing it here would re-fetch the language forever.
  const req = { forced: !!item.forced };
  return subs.some(
    (s) =>
      s.language === item.isoCode &&
      matchesRequestedFlags(s, req) &&
      (opts.imageTracksCount || !isImageBasedSubtitleCodec(s.codec)) &&
      s.status !== SubtitleStatus.FAILED,
  );
}
