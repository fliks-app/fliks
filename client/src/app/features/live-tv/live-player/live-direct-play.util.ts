import { EngineKind, ENGINE_TRAITS } from '../../../core/services/engine-traits';

/** Whether this engine can open a channel's raw upstream instead of the packaged
 *  HLS session. A browser cannot open an endless MPEG-TS at all. */
export function supportsLiveDirectPlay(kind: EngineKind): boolean {
  switch (kind) {
    case EngineKind.DESKTOP:
    case EngineKind.ANDROID_TV:
    case EngineKind.TIZEN:
    case EngineKind.ANDROID:
      return true;
    default:
      return false;
  }
}

/** The live packager emits exactly one audio track (`-map 0:a:0?`), so an
 *  engine that only needs MPEG-TS for single-audio sources needs it here
 *  always. Tizen AVPlay stalls on a single-audio fMP4 HLS (issue #148). */
export function liveNeedsTs(kind: EngineKind): boolean {
  return ENGINE_TRAITS[kind]?.useTsOnSingleAudio === true;
}
