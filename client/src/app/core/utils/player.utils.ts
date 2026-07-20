import type { TranslateService } from '@ngx-translate/core';
import { localizeLanguage, normalizeLangCode } from './language.utils';

/** Pixel widths backing each ladder rung id (must match the backend
 *  `PROFILES` table). Used by NativeEngine + quality-manager to set
 *  ExoPlayer's max-resolution constraint; ExoPlayer matches tracks by
 *  exact width × height, so a 1px mismatch silently picks the wrong
 *  rung.
 *
 *  `original` is intentionally absent — call sites that need it pass a
 *  sentinel resolution directly (the source dimensions, or 99999 when
 *  the source isn't known yet). */
export const PROFILE_WIDTHS: Record<string, number> = {
  '2160p': 3840,
  '1080p': 1920,
  '720p': 1280,
  '480p': 854,
  '360p': 640,
  '240p': 426,
  '144p': 256,
};

/** Resolve a quality id (`'1080p'`, `'1080p-hdr'`, `'eco-1080p'`,
 *  `'original'`, …) to the rung width. Strips the `eco-` prefix (the
 *  low-consumption rung shares its sibling's resolution) and any `-hdr`
 *  suffix. Returns `undefined` for unknown ids so the caller can apply its
 *  own fallback. */
export function widthForProfile(id: string): number | undefined {
  const base = id.replace(/^eco-/, '').replace(/-hdr$/, '');
  return PROFILE_WIDTHS[base];
}

/**
 * Bucket a width × height pair to a display label (`"4K"`, `"1080p"`,
 * `"720p"`, …). Uses ceilings on **both** axes — anamorphic and scope
 * crops (e.g. 1918×872, 1920×800) would mis-bucket with a width-only or
 * height-only threshold because their non-primary axis sits one or two
 * pixels below the round number. Mirrors the backend's `resolveQuality`
 * bucketing so the badge matches the parsed quality stored on the file.
 *
 * Returns null when neither dimension is known.
 */
export function bucketResolutionLabel(
  width?: number | null,
  height?: number | null,
): string | null {
  const w = width ?? 0;
  const h = height ?? 0;
  if (!w && !h) return null;
  if (w <= 720 && h <= 576) return '480p';
  if (w <= 1280 && h <= 962) return '720p';
  if (w <= 1920 && h <= 1440) return '1080p';
  if (w <= 2560 && h <= 1920) return '1440p';
  return '4K';
}

/**
 * Extract the resolution token (`"1080p"`, `"4K"`, …) from a parsed
 * quality name like `"HDTV-1080p"` or `"WEBDL-2160p"`. Quality strings
 * without a resolution suffix (`"CAM"`, `"DVD"`, …) return null so
 * callers can fall back to dimension-based bucketing.
 */
export function resolutionFromQualityName(
  quality?: string | null,
): string | null {
  const m = quality?.match(/-(\d+)p$/i);
  if (!m) return null;
  return m[1] === '2160' ? '4K' : `${m[1]}p`;
}

/** Format seconds to h:mm:ss or m:ss. */
export function formatTime(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** Calculate drag time from a pointer event on a progress bar. */
export function calcDragTime(e: PointerEvent, bar: HTMLElement, duration: number): number {
  const rect = bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  return ratio * (duration || 0);
}

export interface SpriteMetadata {
  interval: number;
  columns: number;
  thumbWidth: number;
  thumbHeight: number;
  count: number;
}

/** Calculate hover percent from a pointer event on a progress bar. */
export function calcHoverPercent(e: PointerEvent, bar: HTMLElement): number {
  const rect = bar.getBoundingClientRect();
  return Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
}

/** Parse audio stream index from track ID (e.g., 'audio-2' → 2). */
export function parseAudioIndex(trackId: string): number {
  return parseInt(trackId.replace(/^(si-|shaka-|audio-)/, ''), 10);
}

/** Map a raw FFmpeg/ffprobe subtitle codec name to a short, user-friendly
 *  tag (PGS, SRT, ASS, VTT). Falls back to "SRT" for external files
 *  (typical) and "EMB" for embedded streams without a codec hint. */
function shortSubtitleCodec(codec: string | null | undefined, hasFile: boolean): string {
  const c = (codec ?? '').toLowerCase();
  if (c === 'hdmv_pgs_subtitle' || c === 'dvd_subtitle' || c === 'dvb_subtitle') return 'PGS';
  if (c === 'subrip') return 'SRT';
  if (c === 'ass' || c === 'ssa') return 'ASS';
  if (c === 'webvtt') return 'VTT';
  if (c === 'mov_text') return 'TX3G';
  if (c) return c.toUpperCase();
  return hasFile ? 'SRT' : 'EMB';
}

/** Channel count to a recognizable layout label (5.1, 7.1, 2.0, …). */
export function audioChannelsLabel(channels: number | null | undefined): string {
  if (!channels) return '';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels}.0`;
}

/**
 * Render an audio track as a dropdown label. Used by both the player and
 * the media-detail audio menu so the text matches in both places.
 *
 * Format: `"<langue> (CODEC - channels)"`, e.g. `"Français (EAC3 - 5.1)"`.
 * Codec and/or channels are dropped when missing.
 *
 * `trackIndex` is the 1-based position of the track in the file's audio
 * list — used to produce a translated `Piste N` / `Audio N` head when
 * the language tag is `und` / `xx`, so the dropdown doesn't surface
 * `und` to the user. Omit the index to keep the literal `und` head
 * (legacy / non-listed callers).
 */
export function formatAudioLabel(
  audio: { language?: string; title?: string; codec?: string; channels?: number },
  translate: TranslateService,
  trackIndex?: number,
): string {
  const norm = normalizeLangCode(audio.language);
  const head =
    trackIndex != null && (norm === 'und' || norm === 'xx')
      ? translate.instant('player.audio_track_n', { index: trackIndex })
      : localizeLanguage(audio.language, translate);
  const codec = (audio.codec ?? '').toUpperCase().replace('TRUEHD', 'TrueHD');
  const channels = audioChannelsLabel(audio.channels);
  const tail = [codec, channels].filter(Boolean).join(' - ');
  return tail ? `${head} (${tail})` : head;
}

/** Two-part audio label for the menu: language head + details ("EAC3 • 5.1"). */
export function formatAudioParts(
  audio: { language?: string; title?: string; codec?: string; channels?: number },
  translate: TranslateService,
  trackIndex?: number,
): { head: string; sub: string } {
  const norm = normalizeLangCode(audio.language);
  const head =
    trackIndex != null && (norm === 'und' || norm === 'xx')
      ? translate.instant('player.audio_track_n', { index: trackIndex })
      : localizeLanguage(audio.language, translate);
  const codec = (audio.codec ?? '').toUpperCase().replace('TRUEHD', 'TrueHD');
  const channels = audioChannelsLabel(audio.channels);
  return { head, sub: [codec, channels].filter(Boolean).join(' • ') };
}

/**
 * Render a subtitle as a dropdown label. Mirrors {@link formatAudioLabel} so
 * the player and media-detail subtitle menus stay consistent.
 *
 * Format: `"<lang> (HI) (Forced) (CODEC)"` with the parenthesised parts
 * omitted when the corresponding flag is absent.
 */
export function formatSubtitleLabel(
  sub: {
    language?: string;
    codec?: string | null;
    forced?: boolean | null;
    hearingImpaired?: boolean | null;
    relativePath?: string | null;
    providerType?: string | null;
  },
  translate: TranslateService,
  trackIndex?: number,
): string {
  const norm = normalizeLangCode(sub.language);
  const head =
    trackIndex != null && (norm === 'und' || norm === 'xx')
      ? translate.instant('player.subtitle_track_n', { index: trackIndex })
      : localizeLanguage(sub.language, translate);
  const parts: string[] = [];
  if (sub.hearingImpaired) parts.push('HI');
  if (sub.forced) parts.push('Forced');
  parts.push(shortSubtitleCodec(sub.codec, !!sub.relativePath));
  const origin = subtitleOriginLabel(sub.providerType, translate);
  if (origin) parts.push(origin);
  return `${head} (${parts.join(') (')})`;
}

/**
 * Two-part subtitle label for the player menu: the language on top and the
 * details ("SRT • Forced • Translated") as a subline, joined with " • ".
 */
export function formatSubtitleParts(
  sub: {
    language?: string;
    codec?: string | null;
    forced?: boolean | null;
    hearingImpaired?: boolean | null;
    relativePath?: string | null;
    providerType?: string | null;
  },
  translate: TranslateService,
  trackIndex?: number,
): { head: string; sub: string } {
  const norm = normalizeLangCode(sub.language);
  const head =
    trackIndex != null && (norm === 'und' || norm === 'xx')
      ? translate.instant('player.subtitle_track_n', { index: trackIndex })
      : localizeLanguage(sub.language, translate);
  const parts: string[] = [shortSubtitleCodec(sub.codec, !!sub.relativePath)];
  if (sub.forced) parts.push('Forced');
  if (sub.hearingImpaired) parts.push('HI');
  const origin = subtitleOriginLabel(sub.providerType, translate);
  if (origin) parts.push(origin);
  return { head, sub: parts.join(' • ') };
}

/** Short origin hint for machine-translated / OCR'd subtitles. Embedded and
 *  downloaded subs get none — their codec already conveys the essentials. */
export function subtitleOriginLabel(
  providerType: string | null | undefined,
  translate: TranslateService,
): string | null {
  if (providerType === 'translated')
    return translate.instant('player.subtitle_source.translated');
  if (providerType === 'ocr')
    return translate.instant('player.subtitle_source.ocr');
  return null;
}
