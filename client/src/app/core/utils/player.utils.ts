import type { TranslateService } from '@ngx-translate/core';
import { localizeLanguage, normalizeLangCode } from './language.utils';
import type { PlayMethod, PlaybackInfoResponse } from '../services/api/streaming-api.service';
import type { EngineStats } from '../services/playback-engine/playback-engine';
import type { AudioStreamInfo, VideoStreamInfo } from '../services/api/media.service';
import type { PlayerStats } from '../../features/player/overlay/player-stats-overlay';

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

/** Canonical codec name for a subtitle sidecar, inferred from its file
 *  extension. External subs (downloaded, disk-scanned) carry no ffprobe
 *  codec, so the extension is the authoritative format hint. */
function subtitleCodecFromPath(relativePath: string): string {
  const ext = relativePath.slice(relativePath.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'srt': return 'subrip';
    case 'vtt': return 'webvtt';
    case 'ass': return 'ass';
    case 'ssa': return 'ssa';
    case 'sup': return 'hdmv_pgs_subtitle';
    case 'sub': return 'dvd_subtitle';
    case 'smi':
    case 'sami': return 'sami';
    default: return '';
  }
}

/** Map a subtitle codec (an ffprobe name, or one inferred from the sidecar
 *  extension) to a short user-facing tag (SRT, ASS, VTT, PGS, …). Returns
 *  an empty string when the format can't be determined, so the caller shows
 *  no tag rather than a misleading default. */
function shortSubtitleCodec(codec: string | null | undefined, relativePath: string | null | undefined): string {
  let c = (codec ?? '').toLowerCase();
  if (!c && relativePath) c = subtitleCodecFromPath(relativePath);
  switch (c) {
    case 'hdmv_pgs_subtitle':
    case 'dvd_subtitle':
    case 'dvb_subtitle': return 'PGS';
    case 'subrip': return 'SRT';
    case 'ass':
    case 'ssa': return 'ASS';
    case 'webvtt': return 'VTT';
    case 'sami': return 'SAMI';
    case 'mov_text': return 'TX3G';
  }
  if (c) return c.toUpperCase();
  return '';
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
 * (callers with no track-list position to number).
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

/** Whether the pickers spell out the file format. Off unless the viewer asked
 *  for it in the subtitle settings. */
export interface SubtitleLabelOptions {
  showFormat?: boolean;
}

/**
 * Render a subtitle as a dropdown label. Mirrors {@link formatAudioLabel} so
 * the player and media-detail subtitle menus stay consistent.
 *
 * Format: `"<lang> (hearing-impaired) (forced) (CODEC)"`, every parenthesised
 * part localised and omitted when the corresponding flag is absent.
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
  opts?: SubtitleLabelOptions,
): string {
  const norm = normalizeLangCode(sub.language);
  const head =
    trackIndex != null && (norm === 'und' || norm === 'xx')
      ? translate.instant('player.subtitle_track_n', { index: trackIndex })
      : localizeLanguage(sub.language, translate);
  const parts: string[] = [];
  if (sub.hearingImpaired) parts.push(translate.instant('player.subtitle_hearing_impaired'));
  if (sub.forced) parts.push(translate.instant('player.subtitle_forced'));
  const codec = opts?.showFormat ? shortSubtitleCodec(sub.codec, sub.relativePath) : '';
  if (codec) parts.push(codec);
  const origin = subtitleOriginLabel(sub.providerType, translate);
  if (origin) parts.push(origin);
  return parts.length ? `${head} (${parts.join(') (')})` : head;
}

/**
 * Two-part subtitle label for the player menu: the language on top and the
 * details ("SRT • forced • translated") as a subline, joined with " • ".
 * Every flag label is localised.
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
  opts?: SubtitleLabelOptions,
): { head: string; sub: string } {
  const norm = normalizeLangCode(sub.language);
  const head =
    trackIndex != null && (norm === 'und' || norm === 'xx')
      ? translate.instant('player.subtitle_track_n', { index: trackIndex })
      : localizeLanguage(sub.language, translate);
  const parts: string[] = [];
  const codec = opts?.showFormat ? shortSubtitleCodec(sub.codec, sub.relativePath) : '';
  if (codec) parts.push(codec);
  if (sub.forced) parts.push(translate.instant('player.subtitle_forced'));
  if (sub.hearingImpaired) parts.push(translate.instant('player.subtitle_hearing_impaired'));
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

export interface TimeMarker {
  startSeconds: number;
  endSeconds: number;
}

/** Inside an intro, with a second of slack at the end so a cue never lingers
 *  onto content the viewer is already watching. */
export function inIntroRange(marker: TimeMarker | null, position: number): boolean {
  if (!marker) return false;
  return position >= marker.startSeconds && position < marker.endSeconds - 1;
}

/** An outro runs to the end of the file, so entering it is enough. */
export function inOutroRange(marker: TimeMarker | null, position: number): boolean {
  if (!marker) return false;
  return position >= marker.startSeconds;
}

export interface CropRect {
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface VideoCropStyle {
  /** Video element's own box, in the source's aspect ratio, pair with
   *  `object-fit: fill` (never distorts, the box already carries that AR). */
  width: number;
  height: number;
  /** CSS px translate that centers the crop rectangle in the container. */
  translateX: number;
  translateY: number;
}

/** CSS box for a `<video>` so only `crop` shows, in coded pixels;
 *  `displayWidth/Height` rescale it for an anamorphic source. */
export function computeVideoCropStyle(params: {
  sourceWidth: number;
  sourceHeight: number;
  crop: CropRect;
  containerWidth: number;
  containerHeight: number;
  fit: 'contain' | 'cover';
  displayWidth?: number;
  displayHeight?: number;
}): VideoCropStyle | null {
  const { sourceWidth: w, sourceHeight: h, crop, containerWidth: cw, containerHeight: ch, fit } = params;
  if (!w || !h || !cw || !ch || !crop?.width || !crop?.height) return null;
  if (crop.width >= w && crop.height >= h) return null;
  const dw = params.displayWidth || w;
  const dh = params.displayHeight || h;
  const sx = dw / w;
  const sy = dh / h;
  const cropW = crop.width * sx;
  const cropH = crop.height * sy;
  const cropX = crop.x * sx;
  const cropY = crop.y * sy;
  const scale =
    fit === 'cover'
      ? Math.max(cw / cropW, ch / cropH)
      : Math.min(cw / cropW, ch / cropH);
  return {
    width: dw * scale,
    height: dh * scale,
    translateX: (cw - cropW * scale) / 2 - cropX * scale,
    translateY: (ch - cropH * scale) / 2 - cropY * scale,
  };
}

export type PlaybackMode = 'direct' | 'remux' | 'transcode';

/** The one `playMethod` to {@link PlaybackMode} mapping. */
export function playbackModeOf(pi: { playMethod: PlayMethod }): PlaybackMode {
  return pi.playMethod === 'DirectPlay'
    ? 'direct'
    : pi.playMethod === 'DirectStream'
      ? 'remux'
      : 'transcode';
}

/** What the engine is actually playing, which a desynced URL can make differ
 *  from `playMethod`; refined by Shaka's `originalVideoId` when available. */
export function deliveredKindFromVariant(
  url: string,
  originalVideoId?: string | null,
): PlaybackMode {
  if (!url.includes('master.m3u8')) return 'direct';
  // A variant still showing from the previous load carries that load's sid.
  const sidOf = (u: string) => /[?&]sid=([^&]+)/.exec(u)?.[1];
  if (originalVideoId != null && sidOf(originalVideoId) === sidOf(url)) {
    return originalVideoId.includes('/remux/') ? 'remux' : 'transcode';
  }
  const hasRemux = /[?&]remux=1(?:&|$)/.test(url);
  const hasStartQuality = /[?&]startQuality=/.test(url);
  return hasRemux && !hasStartQuality ? 'remux' : 'transcode';
}

export interface BuildPlayerStatsParams {
  quality: string;
  pi: PlaybackInfoResponse | null;
  engineStats: EngineStats | undefined;
  hwAccel: string;
  isOfflinePlayback: boolean;
  lastStreamUrl: string;
  /** `originalVideoId` of the engine's active variant (Shaka) — the profile
   *  folder name and the `sid` `deliveredKindFromVariant` reads back. */
  activeVariantOriginalVideoId: string | null | undefined;
  availableQualities: { id: string; totalBitrateBps?: number }[];
  resolutionLabel: (w?: number, h?: number) => string;
  transcodeTierFromVariantHeight: (h: number, w?: number) => string | null;
  translate: TranslateService;
  sourceVideoStream: VideoStreamInfo | undefined;
  /** True when THIS client removed the letterbox bars (copy delivery). */
  cropAppliedByPlayer: boolean;
  isDesktopNative: boolean;
  /** PiP or iOS native fullscreen paints the full frame, bypassing the crop. */
  pipOrFullscreenActive: boolean;
  activeAudioTrackId: string | null;
  availableAudioTracks: { id: string; label: string; language: string }[];
  activeAudioStreamIndex: number | undefined;
  sourceAudioStreams: AudioStreamInfo[] | undefined;
}

/** Pure derivation of the stats-overlay panel from the negotiated
 *  playback-info, engine stats and player UI state. Extracted out of
 *  PlayerComponent so this formatting logic is unit-testable without
 *  mounting the component. */
export function buildPlayerStats(p: BuildPlayerStatsParams): PlayerStats {
  const { pi, engineStats, translate } = p;
  const src = pi?.source;
  const hw = p.hwAccel;
  const activeVariant = engineStats?.activeVariant;

  const playingWidth = activeVariant?.width ?? src?.width;
  const playingHeight = activeVariant?.height ?? src?.height;

  // What the engine is ACTUALLY playing, never the server's playMethod
  // decision alone, which a desynced stream URL can disagree with.
  const deliveredKind = p.isOfflinePlayback || !p.lastStreamUrl
    ? null
    : deliveredKindFromVariant(p.lastStreamUrl, p.activeVariantOriginalVideoId ?? null);
  const effectiveVideoCopy = deliveredKind !== 'transcode';
  // Without a negotiation (offline) nothing says what was copied: show no mode.
  const deliveryKnown = !!pi && deliveredKind != null;
  // Audio is decided independently: a lower video rung still copies a
  // supported audio track (e.g. AC3 5.1) verbatim, so reflect audioCopyStream.
  const effectiveAudioCopy = pi?.audioCopyStream ?? true;
  // Per-track audio decision for the ACTIVE track. availableAudioTracks is in
  // streamInfo.audio order (the i-th track maps to streamInfo.audio[i]), so
  // the selected track's position is its backend audioTracks index.
  const activeAudioPos = p.availableAudioTracks.findIndex(
    (t) => t.id === p.activeAudioTrackId,
  );
  const activeAudioIndex =
    activeAudioPos >= 0 ? activeAudioPos : (p.activeAudioStreamIndex ?? 0);
  const activeAudioPlan = pi?.audioTracks?.find(
    (t) => t.index === activeAudioIndex,
  );
  const activeAudioCopy = activeAudioPlan?.copy ?? effectiveAudioCopy;

  const formatBitrateBps = (bps: number): string => {
    if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
    if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} kbps`;
    return `${bps} bps`;
  };

  // --- Container (summary) ---
  const totalContainerBps =
    src?.formatBitRate ??
    (src?.videoBitRate != null
      ? (src.videoBitRate ?? 0) + (src.audioBitRate ?? 0)
      : undefined);
  const containerBitrate =
    totalContainerBps != null && totalContainerBps > 0
      ? formatBitrateBps(totalContainerBps)
      : '?';

  const isHls = deliveredKind != null && deliveredKind !== 'direct';
  const outputFormat = isHls ? 'HLS' : '';
  const outputFps = src?.frameRate ?? '';

  // Letterbox crop detected at import time (ffprobe `cropdetect`).
  const cropLine = src?.crop
    ? `${src.crop.width}x${src.crop.height} (offset ${src.crop.x},${src.crop.y})`
    : '';
  const cropAppliedByPlayer = p.cropAppliedByPlayer;
  // PiP and iOS native fullscreen paint the decoded frame, bypassing the CSS crop.
  const cropBypassed = cropAppliedByPlayer && !p.isDesktopNative && p.pipOrFullscreenActive;

  // --- Video label ---
  const urlMatch = p.activeVariantOriginalVideoId?.match(/\/(\d+p)\//);
  const selectedQualityOpt = p.availableQualities.find((q) => q.id === p.quality);
  const resLabel = p.resolutionLabel(src?.width, src?.height);
  // A tonemapped delivery is SDR; corroborate DV with the engine's own codec
  // string (if reported) so a plain-HEVC/AV1 fallback never claims DV.
  const engineVideoCodec = activeVariant?.videoCodec?.toLowerCase();
  const showsDolbyVision =
    !!pi?.dolbyVision &&
    deliveredKind !== 'transcode' &&
    (engineVideoCodec == null || /^(dv|dav1)/.test(engineVideoCodec));
  // Real profile/compat, not guessed from hdrFormat: an untagged P5 source
  // has no HDR VUI at all, so this must run before the `!src?.hdrFormat` case.
  const dvStream = p.sourceVideoStream;
  const hdrTag = pi?.tonemapping
    ? ''
    : showsDolbyVision && dvStream?.dvProfile != null
      ? ` ${
          dvStream.dvBlSignalCompatId
            ? translate.instant('player.stats_dolby_vision_base', {
                profile: `${dvStream.dvProfile}.${dvStream.dvBlSignalCompatId}`,
                base: src?.hdrFormat ?? '',
              })
            : translate.instant('player.stats_dolby_vision', {
                profile: dvStream.dvProfile,
              })
        }`
      : src?.hdrFormat
        ? ` ${src.hdrFormat}`
        : '';
  const codecName = (src?.videoCodec ?? '?').toUpperCase();
  const videoLabel = `${resLabel}${hdrTag} ${codecName}`;

  const rateMap = pi?.transcodeBitrateByQuality;
  const qId = p.quality;
  const sourceA = src?.audioBitRate;

  // Ladder targets describe a transcode only; a copy never borrows a rung's figure.
  const isTranscodeDelivery = deliveredKind === 'transcode';

  let selectedRateEntry: {
    videoBitrateBps: number;
    audioBitrateBps: number;
    totalBitrateBps: number;
  } | null = null;
  if (isTranscodeDelivery) {
    if (rateMap && qId !== 'auto' && qId !== 'original' && rateMap[qId]) {
      selectedRateEntry = rateMap[qId];
    } else if (rateMap && (qId === 'auto' || qId === 'original')) {
      const tier = urlMatch?.[1] ?? p.transcodeTierFromVariantHeight(activeVariant?.height ?? 0, activeVariant?.width);
      if (tier && rateMap[tier]) selectedRateEntry = rateMap[tier];
    }
  }

  const validBps = (n: unknown): n is number =>
    typeof n === 'number' && !Number.isNaN(n) && n > 0;

  // Video stream bitrate
  let videoStreamBitrate = '';
  let serverStreamTotalBps: number | undefined;
  // The rung's own video target (eco / -hdr rungs included); its audio budget
  // is not spent when the audio is copied. A pinned rung's total stands in without it.
  if (validBps(selectedRateEntry?.videoBitrateBps)) {
    serverStreamTotalBps = selectedRateEntry!.videoBitrateBps;
  } else if (
    isTranscodeDelivery &&
    qId !== 'auto' &&
    qId !== 'original' &&
    validBps(selectedQualityOpt?.totalBitrateBps)
  ) {
    serverStreamTotalBps = selectedQualityOpt!.totalBitrateBps;
  } else if (deliveredKind != null && !isTranscodeDelivery && validBps(src?.videoBitRate)) {
    // A copy's own video bitrate; remuxMasterBandwidthBps also counts audio.
    serverStreamTotalBps = src!.videoBitRate;
  } else if (deliveredKind === 'remux' && validBps(pi?.remuxMasterBandwidthBps)) {
    serverStreamTotalBps = pi!.remuxMasterBandwidthBps;
  }

  if (serverStreamTotalBps != null && serverStreamTotalBps > 0) {
    videoStreamBitrate = formatBitrateBps(serverStreamTotalBps);
  } else {
    const trackVbw = activeVariant?.videoBandwidth;
    const shakaStreamBw = engineStats?.streamBandwidth;
    if (validBps(trackVbw)) {
      videoStreamBitrate = formatBitrateBps(trackVbw);
    } else if (validBps(shakaStreamBw)) {
      videoStreamBitrate = formatBitrateBps(shakaStreamBw);
    }
  }

  const profileParts: string[] = [];
  if (src?.videoProfile) profileParts.push(src.videoProfile);
  if (src?.videoLevel) profileParts.push(String(src.videoLevel));
  if (src?.frameRate) profileParts.push(`${src.frameRate} fps`);
  const videoProfileLine = profileParts.join('  ') || '?';

  // Delivery, not decision: `deliveredKind` already folds in a pinned rung,
  // so a remux whose rung was pinned reports the transcode it actually is.
  const streamTypeKey = deliveredKind ? `player.stats_stream_type_${deliveredKind}` : '';

  // Flag when the server's decision disagrees with what's actually playing,
  // instead of silently trusting either side.
  const decisionKind = pi ? playbackModeOf(pi) : undefined;
  const mismatch =
    decisionKind && deliveredKind && decisionKind !== deliveredKind
      ? translate.instant('player.stats_delivery_mismatch', {
          decision: translate.instant(`player.stats_stream_type_${decisionKind}`),
          delivered: translate.instant(`player.stats_stream_type_${deliveredKind}`),
        })
      : undefined;

  // Playback mode for video
  let videoPlaybackMode: string;
  if (!deliveryKnown) {
    videoPlaybackMode = '';
  } else if (effectiveVideoCopy) {
    videoPlaybackMode = translate.instant('player.stats_direct_playback');
  } else {
    const hwLabel: Record<string, string> = { qsv: 'QSV', vaapi: 'VAAPI', nvenc: 'NVENC', videotoolbox: 'Apple VT', none: 'CPU' };
    const parts = [hwLabel[hw] ?? hw.toUpperCase()];
    if (pi?.outputVideoCodec) parts.push(pi.outputVideoCodec.toUpperCase());
    // HDR survives the transcode only when the source is HDR and we're not
    // tonemapping to SDR — surface the format (HDR10 / HLG) that's emitted.
    if (src?.hdrFormat && !pi?.tonemapping) parts.push(src.hdrFormat);
    videoPlaybackMode = translate.instant('player.stats_transcoding', { hw: parts.join(' ') });
  }
  if (playingHeight && src?.height && playingHeight < src.height) {
    videoPlaybackMode += ` → ${playingWidth}x${playingHeight}`;
  }

  // Show the filter ACTUALLY used (post auto-resolution + opencl-probe
  // fallback), not the admin pick — `pi.tonemapAlgo` is the source of truth.
  const tonemapLabel: Record<string, string> = {
    vaapi: 'VAAPI',
    opencl: 'OpenCL',
    qsv: 'vpp_qsv',
    cuda: 'CUDA',
    vulkan: 'Vulkan',
    videotoolbox: 'VideoToolbox',
    cpu: 'CPU',
  };
  // cuda/opencl/vulkan/cpu run a tunable curve, shown in parentheses;
  // vpp_qsv/VAAPI LUTs carry none.
  const curve = pi?.tonemapCurve
    ? ` (${pi.tonemapCurve.charAt(0).toUpperCase()}${pi.tonemapCurve.slice(1)})`
    : '';
  const tonemapAlgoLabel = pi?.tonemapAlgo
    ? `${tonemapLabel[pi.tonemapAlgo] ?? pi.tonemapAlgo}${curve}`
    : '';
  const tonemapping = pi?.tonemapping
    ? tonemapAlgoLabel || 'enabled'
    : pi?.clientTonemap
      ? translate.instant('player.stats_tonemapping_client')
      : '';

  // Video: `Video*` flags plus `SubtitleBurnIn`. Audio: `Audio*` flags.
  // Everything else (container/mux/server-policy) goes in the stream section, never dropped.
  const allFlags = (pi?.transcodeReasons ?? []).map((r) => r.flag);
  // Translate each flag to a human label; unknown flags fall back to the raw token.
  const reasonLabel = (flag: string) => {
    const key = `player.transcode_reason.${flag}`;
    const label = translate.instant(key, { codec: codecName });
    return label === key ? flag : label;
  };
  const videoTranscodeReasons = effectiveVideoCopy
    ? []
    : allFlags
        .filter((f) => f.startsWith('Video') || f === 'SubtitleBurnIn')
        .map(reasonLabel);
  // Prefer the active track's own per-track plan (correct after a client-side
  // switch); fall back to the default-track flags on an older server.
  const audioTranscodeReasons = activeAudioPlan
    ? activeAudioPlan.reasonFlags.map(reasonLabel)
    : effectiveAudioCopy
      ? []
      : allFlags.filter((f) => f.startsWith('Audio')).map(reasonLabel);
  const streamTranscodeReasons = allFlags
    .filter((f) => !f.startsWith('Video') && !f.startsWith('Audio') && f !== 'SubtitleBurnIn')
    .map(reasonLabel);

  // --- Audio ---
  // `audioTracks: []` (or an explicitly empty source streamInfo.audio when
  // offline) means the file truly has none; undefined means unknown metadata,
  // not "no audio"; keep showing the section rather than assume neither.
  const sourceAudioStreams = p.sourceAudioStreams;
  const hasAudio =
    pi?.audioTracks != null
      ? pi.audioTracks.length > 0
      : sourceAudioStreams != null
        ? sourceAudioStreams.length > 0
        : true;
  // Derive from the SELECTED track, not the source's primary stream, so the
  // line follows a language switch.
  const selectedAudio = p.availableAudioTracks.find(
    (t) => t.id === p.activeAudioTrackId,
  );
  // Show the audio NAME exactly as the track selector renders it:
  // selectedAudio.label is built by formatAudioLabel, which localizes the
  // language and falls back to "Piste audio N" for untagged tracks instead of
  // a raw "Und". Fall back to formatAudioLabel on the source's primary stream
  // when no track is selected yet (tracks not populated).
  const audioLabel =
    selectedAudio?.label ??
    formatAudioLabel(
      {
        language: src?.audioLanguage,
        codec: src?.audioCodec,
        channels: src?.audioChannels,
      },
      translate,
      1,
    );

  // The active track's plan carries its own figures. `src` audio values describe
  // the negotiated track, so they stand in only without a plan and for a copy.
  const sourceAudioIsActive = !activeAudioPlan && deliveryKnown && activeAudioCopy;
  let audioStreamBitrate = '';
  if (validBps(activeAudioPlan?.bitrateBps)) {
    audioStreamBitrate = formatBitrateBps(activeAudioPlan!.bitrateBps!);
  } else if (sourceAudioIsActive && validBps(sourceA)) {
    audioStreamBitrate = formatBitrateBps(sourceA);
  } else if (validBps(activeVariant?.audioBandwidth)) {
    audioStreamBitrate = formatBitrateBps(activeVariant!.audioBandwidth);
  } else if (!activeAudioCopy && selectedRateEntry && validBps(selectedRateEntry.audioBitrateBps)) {
    audioStreamBitrate = formatBitrateBps(selectedRateEntry.audioBitrateBps);
  }

  const activeSampleRate =
    activeAudioPlan?.sampleRate ?? (sourceAudioIsActive ? src?.audioSampleRate : undefined);
  const audioDetailLine = activeSampleRate ? `${activeSampleRate} Hz` : '';

  let audioPlaybackMode: string;
  if (!deliveryKnown) {
    audioPlaybackMode = '';
  } else if (activeAudioCopy) {
    audioPlaybackMode = translate.instant('player.stats_direct_playback');
  } else {
    // Show the TARGET codec + channel layout (e.g. "OPUS - 5.1") so a downmix
    // is visible. `outputChannels` comes from the active track's plan.
    const outCodec = (
      activeAudioPlan?.outputCodec ?? pi?.outputAudioCodec ?? 'aac'
    ).toUpperCase();
    const outLayout = audioChannelsLabel(activeAudioPlan?.outputChannels);
    const codecLabel = outLayout ? `${outCodec} - ${outLayout}` : outCodec;
    audioPlaybackMode = translate.instant('player.stats_transcode_audio', { codec: codecLabel });
  }

  return {
    container: src?.container ?? '?',
    containerBitrate,
    outputFormat,
    outputFps,
    streamTypeKey,
    mismatch,
    streamTranscodeReasons,
    videoLabel,
    videoStreamBitrate,
    videoProfileLine,
    videoPlaybackMode,
    crop: cropLine,
    cropAppliedByPlayer,
    cropBypassed,
    tonemapping,
    videoTranscodeReasons,
    // Engine stats can read NaN before a quality switch settles; show 0.
    droppedFrames: Number.isFinite(engineStats?.droppedFrames)
      ? engineStats!.droppedFrames
      : 0,
    hasAudio,
    audioLabel,
    audioStreamBitrate,
    audioDetailLine,
    audioPlaybackMode,
    audioTranscodeReasons,
  };
}
