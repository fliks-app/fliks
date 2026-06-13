import { TvPlatform } from './device.service';

/**
 * Distinct playback-engine kinds, one per unique behavioural trait-row. The
 * engine drives four flags the backend keys streaming decisions on
 * (see `EngineTraits`). Every supported client maps to exactly one kind:
 *
 *  - WEB        — browser web build (Shaka / MSE).
 *  - NATIVE     — Capacitor mobile (ExoPlayer on Android, AVPlayer on iOS).
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
 * splits into NATIVE (Capacitor mobile) vs WEB (browser) on `isNative`;
 * that split is what `probesSegZero` keys on. CAST is selected explicitly by
 * the Cast player and never resolved through this function.
 */
export function engineKindFor(tvPlatform: TvPlatform, isNative: boolean): EngineKind {
  switch (tvPlatform) {
    case 'tizen':
      return EngineKind.TIZEN;
    case 'webos':
      return EngineKind.WEBOS;
    case 'androidtv':
      return EngineKind.ANDROID_TV;
    default:
      return isNative ? EngineKind.NATIVE : EngineKind.WEB;
  }
}
