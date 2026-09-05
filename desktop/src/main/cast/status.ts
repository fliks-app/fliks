import type { DesktopCastEvent } from '../../shared/contract';

/** Pure mapping of the receiver's media bus onto the events the renderer
 *  consumes. Kept apart from the sender so it stays free of Electron and can
 *  be exercised directly. */

export interface CastTrack {
  trackId: number;
  type?: string;
  name?: string;
  language?: string;
}

/** Translate one MEDIA_STATUS entry. `duration` rides the `media` block, which
 *  the receiver only sends on the first status after a LOAD, so the caller
 *  keeps the last one it saw. */
export function mediaStatusEvent(
  status: Record<string, unknown>,
  media: Record<string, unknown> | undefined,
): DesktopCastEvent {
  const playerState = String(status['playerState'] ?? '');
  if (playerState === 'IDLE' && status['idleReason'] === 'ERROR') {
    return {
      name: 'castError',
      detail: { position: Number(status['currentTime']) || undefined },
    };
  }
  const volume = status['volume'] as { level?: number; muted?: boolean } | undefined;
  return {
    name: 'castMediaUpdate',
    detail: {
      currentTime: Number(status['currentTime']) || 0,
      duration: Number(media?.['duration']) || undefined,
      isPaused: playerState === 'PAUSED',
      buffering: playerState === 'BUFFERING',
      volume: volume?.level,
      muted: volume?.muted,
    },
  };
}

/**
 * Build the activeTrackIds for an EDIT_TRACKS_INFO. CAF replaces the whole
 * active set in one shot, so the track type left unspecified has to be re-sent
 * from the current selection or it goes silent.
 *   undefined → keep whatever is active for that type
 *   null      → disable that type
 *   number    → make it the active track of that type
 */
export function mergeActiveTracks(
  tracks: CastTrack[],
  active: number[],
  update: { audioId?: number | null; textId?: number | null },
): number[] {
  const activeOfType = (type: string) =>
    active.find((id) => tracks.some((t) => t.trackId === id && t.type === type));
  const audioId = update.audioId === undefined ? activeOfType('AUDIO') : update.audioId;
  const textId = update.textId === undefined ? activeOfType('TEXT') : update.textId;
  return [audioId, textId].filter((id): id is number => id != null);
}

/** Match an audio rendition by name first: Shaka rewrites HLS LANGUAGE from
 *  ISO 639-2 to 639-1, so plain language equality misses 3-letter sources. */
export function pickAudioTrack(
  tracks: CastTrack[],
  language: string,
  name: string,
): CastTrack | undefined {
  const audio = tracks.filter((t) => t.type === 'AUDIO');
  return audio.find((t) => t.name === name) ?? audio.find((t) => t.language === language);
}
