import type { LiveSession } from '../live-session.service';
import type { MediaFileInfo } from '../../subtitles/ffprobe.service';
import { pickAudioLayout } from './audio-layout';
import {
  buildPlaybackProfileFromContext,
  computeProfileHash,
} from './profile-hash';
import { sourceTimeline } from './source-timeline';
import type { SessionContext } from './types';

/** What playback-info freezes on the LiveSession and every HLS request of the
 *  session rebuilds its context, and so its cache hash, from. */
export type SessionLayout = Pick<
  LiveSession,
  'useTs' | 'audioPlan' | 'audioTrackPlans' | 'videoVariant' | 'timeline'
>;

/** The session fields the cache profile hash is derived from. The timeline
 *  frozen at playback-info wins, so a rescan mid-playback moves no session. */
export function sessionLayoutContext(
  live: Partial<SessionLayout> | null | undefined,
  si: MediaFileInfo | null | undefined,
  label: string,
): Pick<
  SessionContext,
  | 'useTs'
  | 'videoOnly'
  | 'audioStreams'
  | 'audioPlan'
  | 'audioTrackPlans'
  | 'videoVariant'
  | 'sourceStartPts'
  | 'sourceFormatStart'
  | 'sourceEndSeconds'
  | 'sourceClockBreakSeconds'
> {
  const useTs = live?.useTs ?? false;
  const timeline = live?.timeline ?? sourceTimeline(si, label);
  return {
    useTs,
    // Multi-audio: video-only segments plus one var_stream_map rendition per
    // track, so the player switches client-side via EXT-X-MEDIA.
    videoOnly:
      pickAudioLayout(si?.audio?.length ?? 0, useTs ? 'ts' : 'fmp4') ===
      'var-stream-map',
    // With `streamIndex`, so the single-track path maps `0:<abs>` too.
    audioStreams: si?.audio ?? undefined,
    audioPlan: live?.audioPlan ?? undefined,
    audioTrackPlans: live?.audioTrackPlans ?? undefined,
    // Undefined only before a sid exists (the userId-based findCurrent fallback).
    videoVariant: live?.videoVariant ?? undefined,
    sourceStartPts: timeline.origin,
    sourceFormatStart: timeline.formatStart,
    sourceEndSeconds: timeline.end,
    sourceClockBreakSeconds: timeline.clockBreak,
  };
}

/** Cache profile hash of a session, as `computeProfileHashForCtx` derives it
 *  from the context `SessionContextBuilder.build` returns for it. */
export function sessionProfileHash(
  live: Partial<SessionLayout> | null | undefined,
  si: MediaFileInfo | null | undefined,
  label: string,
  segmentDurationSeconds: number,
): string {
  return computeProfileHash(
    buildPlaybackProfileFromContext(
      sessionLayoutContext(live, si, label),
      segmentDurationSeconds * 1000,
    ),
  );
}
