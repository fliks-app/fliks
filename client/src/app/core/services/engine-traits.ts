import { TvPlatform } from './device.service';

/**
 * Distinct playback-engine kinds, one per unique behavioural trait-row. The
 * engine drives four flags the backend keys streaming decisions on
 * (see `EngineTraits`). Every supported client maps to exactly one kind:
 *
 *  - WEB        — browser web build (Shaka / MSE).
 *  - NATIVE     — Capacitor mobile (ExoPlayer on Android, AVPlayer on iOS).
 *  - DESKTOP    — Electron desktop client (embedded mpv).
 *  - ANDROID_TV — Android TV box / 10-foot ExoPlayer build.
 *  - TIZEN      — Samsung Smart TV (AVPlay, HLS-only).
 *  - WEBOS      — LG Smart TV (native `<video>`).
 *  - CAST       — Chromecast receiver (Shaka), built by the Cast player.
 *
 * Adding a platform is a single edit: a new `EngineKind` member, one
 * `ENGINE_TRAITS` row, and one `engineKindFor` branch.
 */
export enum EngineKind {
  WEB = 'web',
  NATIVE = 'native',
  DESKTOP = 'desktop',
  ANDROID_TV = 'androidtv',
  TIZEN = 'tizen',
  WEBOS = 'webos',
  CAST = 'cast',
}

/**
 * The four engine-behavioural flags on `DeviceProfile`. Each is optional
 * because `undefined` is load-bearing on the wire: the DTO marks them
 * `@IsOptional()` and an absent `supportsDirectPlay` is read as `true` by the
 * backend. A row that omits a key emits `undefined` (no key in the JSON),
 * which must stay distinct from an explicit `false`.
 */
export interface EngineTraits {
  /** Force MPEG-TS HLS only for single-audio sources (Tizen AVPlay). */
  useTsOnSingleAudio?: boolean;
  /** Engine consumes HLS `SUBTITLES` renditions natively. */
  supportsHlsSubtitles?: boolean;
  /** Engine fetches seg-0 on a load-then-seek (web/Shaka + Cast receiver). */
  probesSegZero?: boolean;
  /** Engine can play a raw progressive file as DirectPlay. */
  supportsDirectPlay?: boolean;
}

/**
 * Single source of truth for the four engine traits, one row per `EngineKind`.
 *
 * The CAST row sets only `probesSegZero` so the other three serialise as
 * `undefined` (absent from the payload), matching the hand-rolled Cast
 * profile. The TV-platform rows are always reached with `isNative === true`:
 * the only UA markers that set a non-null `tvPlatform` also match the
 * `isNative` regex, so no `isNative === false` TV row is reachable today.
 */
export const ENGINE_TRAITS: Record<EngineKind, EngineTraits> = {
  [EngineKind.WEB]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: true,
    probesSegZero: true,
    supportsDirectPlay: true,
  },
  [EngineKind.NATIVE]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: true,
    probesSegZero: false,
    supportsDirectPlay: true,
  },
  // Embedded mpv: renders behind the UI like NATIVE, but its ffmpeg HLS
  // demuxer fetches seg-0 on load then seeks (like Shaka), so it needs the
  // seg-0 early-start companion — otherwise resuming HLS content (e.g. an HDR
  // transcode) 404s on seg-0 and mpv aborts with an end-file error.
  //
  // Subtitles are loaded sidecar (mpv `sub-add`), not as an HLS SUBTITLES
  // rendition: the rendition is a single-segment VOD playlist over the whole
  // VTT, and mpv's ffmpeg HLS demuxer re-reads that segment on every seek
  // without clearing the prior cue set, so cues accumulate/stack. `sub-add`
  // parses the VTT once and seeks within it natively (like the browser).
  [EngineKind.DESKTOP]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: false,
    probesSegZero: true,
    supportsDirectPlay: true,
  },
  [EngineKind.ANDROID_TV]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: true,
    probesSegZero: false,
    supportsDirectPlay: true,
  },
  [EngineKind.TIZEN]: {
    useTsOnSingleAudio: true,
    supportsHlsSubtitles: false,
    probesSegZero: false,
    supportsDirectPlay: false,
  },
  [EngineKind.WEBOS]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: false,
    probesSegZero: false,
    supportsDirectPlay: true,
  },
  [EngineKind.CAST]: {
    probesSegZero: true,
  },
};

/**
 * Resolve the playback-engine kind from the detected platform and the
 * `isNative` flag (`ServerConfigService.isNative`). A null `tvPlatform`
 * splits into DESKTOP (Electron + embedded mpv), NATIVE (Capacitor mobile),
 * or WEB (browser); that split is what `probesSegZero` keys on. CAST is
 * selected explicitly by the Cast player and never resolved through this
 * function.
 */
export function engineKindFor(
  tvPlatform: TvPlatform,
  isNative: boolean,
  isDesktop = false,
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
      return isNative ? EngineKind.NATIVE : EngineKind.WEB;
  }
}
