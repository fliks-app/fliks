import { TvPlatform } from './device.service';

/** One kind per distinct behavioural trait-row (see `EngineTraits`).
 *  Adding a platform: a new member, one `ENGINE_TRAITS` row and one `engineKindFor` branch. */
export enum EngineKind {
  WEB = 'web',
  ANDROID = 'android',
  IOS = 'ios',
  DESKTOP = 'desktop',
  ANDROID_TV = 'androidtv',
  TIZEN = 'tizen',
  WEBOS = 'webos',
  CAST = 'cast',
}

/** Engine flags on `DeviceProfile`, optional because an absent key must stay distinct from `false` on the wire (absent `supportsDirectPlay` reads as `true`). */
export interface EngineTraits {
  /** Force MPEG-TS HLS only for single-audio sources (Tizen AVPlay). */
  useTsOnSingleAudio?: boolean;
  /** A single-audio source may keep its video copied into MPEG-TS, so only the audio is re-encoded (needs an engine that reads it). */
  supportsTsRemux?: boolean;
  /** Engine consumes HLS `SUBTITLES` renditions natively. */
  supportsHlsSubtitles?: boolean;
  /** Engine surfaces one audio track per LANGUAGE rather than one per
   *  rendition, so same-language renditions can't be picked client-side. */
  dedupesAudioByLanguage?: boolean;
  /** Engine (AVKit) names the single audio muxed into the variants from a
   *  URI-less `EXT-X-MEDIA`; Shaka throws on one, so every other row leaves it off. */
  supportsMuxedAudioRendition?: boolean;
  /** Engine accelerates HLS from an `EXT-X-I-FRAME-STREAM-INF` rendition
   *  (Tizen AVPlay `setSpeed`). */
  supportsIFrameTrickPlay?: boolean;
  /** Engine renders bitmap (PGS/VOBSUB) subtitles from the container, so only DirectPlay carries them; otherwise burned in server-side. */
  supportsImageSubtitles?: boolean;
  /** Engine can attach a text subtitle to a raw DirectPlay file; else it needs an HLS `SUBTITLES` rendition. Client-only (absent on CAST). */
  sideloadsDirectPlaySubtitles?: boolean;
  /** Engine fetches seg-0 on a load-then-seek (web/Shaka + Cast receiver). */
  probesSegZero?: boolean;
  /** Engine can play a raw progressive file as DirectPlay. */
  supportsDirectPlay?: boolean;
  /** Client-side ABR (variant switching mid-playback). Client-only, so a plain required boolean. */
  supportsAbr: boolean;
}

/** Single source of truth for engine traits, one row per `EngineKind`. TV rows are only reached with `isNative === true`:
 *  the UA markers that set `tvPlatform` also match the `isNative` regex. */
export const ENGINE_TRAITS: Record<EngineKind, EngineTraits> = {
  [EngineKind.WEB]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: true,
    supportsImageSubtitles: false,
    sideloadsDirectPlaySubtitles: true,
    probesSegZero: true,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  [EngineKind.ANDROID]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: true,
    supportsImageSubtitles: true,
    sideloadsDirectPlaySubtitles: true,
    probesSegZero: false,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  // AVPlayer has no bitmap subtitle output and takes no sideloaded subtitle for
  // a progressive item: both need the HLS master (burn-in, SUBTITLES renditions).
  [EngineKind.IOS]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: true,
    supportsMuxedAudioRendition: true,
    supportsImageSubtitles: false,
    sideloadsDirectPlaySubtitles: false,
    probesSegZero: false,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  // mpv's ffmpeg HLS demuxer fetches seg-0 on load then seeks, so it needs the seg-0 early-start companion.
  // Sidecar subtitles (`sub-add`): mpv re-reads an HLS rendition segment on every seek, stacking cues. No ABR: one variant at open, so a single rung via `startQuality`.
  [EngineKind.DESKTOP]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: false,
    supportsImageSubtitles: true,
    sideloadsDirectPlaySubtitles: true,
    probesSegZero: true,
    supportsDirectPlay: true,
    supportsAbr: false,
  },
  [EngineKind.ANDROID_TV]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: true,
    supportsImageSubtitles: true,
    sideloadsDirectPlaySubtitles: true,
    probesSegZero: false,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  // AVPlay `open()` takes any remote URI, not just a manifest, and demuxes
  // MKV natively, so a compatible source Direct Plays without a remux.
  [EngineKind.TIZEN]: {
    useTsOnSingleAudio: true,
    supportsTsRemux: true,
    supportsHlsSubtitles: false,
    supportsIFrameTrickPlay: true,
    supportsImageSubtitles: false,
    sideloadsDirectPlaySubtitles: true,
    probesSegZero: false,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  // webOS folds the audio group by language (eng/eng/hin gives two entries): a second English rendition is unreachable, only a reload swaps it.
  [EngineKind.WEBOS]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: false,
    dedupesAudioByLanguage: true,
    supportsImageSubtitles: false,
    sideloadsDirectPlaySubtitles: true,
    probesSegZero: false,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  [EngineKind.CAST]: {
    probesSegZero: true,
    supportsAbr: true,
  },
};

/** Resolve the engine kind from `tvPlatform` and `isNative`; a null `tvPlatform` splits DESKTOP/IOS/ANDROID/WEB (what `probesSegZero` keys on). CAST is never resolved here. */
export function engineKindFor(
  tvPlatform: TvPlatform,
  isNative: boolean,
  isDesktop = false,
  isIos = false,
): EngineKind {
  switch (tvPlatform) {
    case 'tizen':
      return EngineKind.TIZEN;
    case 'webos':
      return EngineKind.WEBOS;
    case 'androidtv':
      return EngineKind.ANDROID_TV;
    default:
      // Desktop is also `isNative` (the Electron UA matches), so it must be
      // checked first.
      if (isDesktop) return EngineKind.DESKTOP;
      if (!isNative) return EngineKind.WEB;
      return isIos ? EngineKind.IOS : EngineKind.ANDROID;
  }
}
