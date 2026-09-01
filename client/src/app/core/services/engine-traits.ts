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
  /** Engine accelerates HLS from an `EXT-X-I-FRAME-STREAM-INF` rendition
   *  (Tizen AVPlay `setSpeed`). */
  supportsIFrameTrickPlay?: boolean;
  /** Engine renders bitmap (PGS/VOBSUB) subtitle tracks itself, so they're
   *  shown natively instead of burned into the video server-side. */
  supportsImageSubtitles?: boolean;
  /** Engine fetches seg-0 on a load-then-seek (web/Shaka + Cast receiver). */
  probesSegZero?: boolean;
  /** Engine can play a raw progressive file as DirectPlay. */
  supportsDirectPlay?: boolean;
  /** Engine has its own client-side ABR (bitrate-adaptive variant switching
   *  mid-playback). Client-only — never sent to the backend, so it's a plain
   *  required boolean rather than the wire-optional pattern above. */
  supportsAbr: boolean;
}

/**
 * Single source of truth for the four wire engine traits plus `supportsAbr`,
 * one row per `EngineKind`.
 *
 * The CAST row sets `supportsAbr` (a local-only decision, never on the wire)
 * plus `probesSegZero`, leaving the other three `undefined` (absent from the
 * payload), matching the hand-rolled Cast profile. The TV-platform rows are
 * always reached with `isNative === true`: the only UA markers that set a
 * non-null `tvPlatform` also match the `isNative` regex, so no
 * `isNative === false` TV row is reachable today.
 */
export const ENGINE_TRAITS: Record<EngineKind, EngineTraits> = {
  [EngineKind.WEB]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: true,
    supportsImageSubtitles: false,
    probesSegZero: true,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  [EngineKind.NATIVE]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: true,
    supportsImageSubtitles: true,
    probesSegZero: false,
    supportsDirectPlay: true,
    supportsAbr: true,
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
  //
  // `supportsAbr: false` — mpv picks one HLS variant when it opens the master
  // playlist (`--hls-bitrate=max`) and never re-evaluates it mid-playback, so
  // the backend must be told a single rung via `startQuality` instead of the
  // full ladder.
  [EngineKind.DESKTOP]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: false,
    supportsImageSubtitles: true,
    probesSegZero: true,
    supportsDirectPlay: true,
    supportsAbr: false,
  },
  [EngineKind.ANDROID_TV]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: true,
    supportsImageSubtitles: true,
    probesSegZero: false,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  // AVPlay `open()` takes any remote URI, not just a manifest, and demuxes
  // MKV natively, so a compatible source Direct Plays without a remux.
  [EngineKind.TIZEN]: {
    useTsOnSingleAudio: true,
    supportsHlsSubtitles: false,
    supportsIFrameTrickPlay: true,
    supportsImageSubtitles: false,
    probesSegZero: false,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  [EngineKind.WEBOS]: {
    useTsOnSingleAudio: false,
    supportsHlsSubtitles: false,
    supportsImageSubtitles: false,
    probesSegZero: false,
    supportsDirectPlay: true,
    supportsAbr: true,
  },
  [EngineKind.CAST]: {
    probesSegZero: true,
    supportsAbr: true,
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
