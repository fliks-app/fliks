import type { LiveSession } from '../live-session.service';
import type { MediaFileInfo } from '../../subtitles/ffprobe.service';
import { audioLayout } from './audio-layout';
import {
  buildPlaybackProfileFromContext,
  computeProfileHash,
} from './profile-hash';
import { sourceTimeline } from './source-timeline';
import type { SessionContext } from './types';
import { DEFAULT_TONEMAP_CURVE } from './codec/types';

/** What playback-info freezes on the LiveSession and every HLS request of the
 *  session rebuilds its context, and so its cache hash, from. */
export type SessionLayout = Pick<
  LiveSession,
  | 'useTs'
  | 'audioPlan'
  | 'audioTrackPlans'
  | 'videoVariant'
  | 'timeline'
  | 'sourceVersion'
  | 'dolbyVision'
  | 'sourceHdr10Plus'
  | 'sourceDvProfile'
  | 'sourceDvBlSignalCompatId'
  | 'audioStreams'
  | 'tonemapping'
  | 'tonemapCurve'
>;

/** Every context field the cache profile hash may read: playback-info has
 *  only these, so a hash input outside them forks it from the requests'. */
export type SessionLayoutContext = Pick<
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
  | 'sourceVersion'
  | 'dolbyVision'
  | 'tonemap'
  | 'sourceDvProfile'
  | 'sourceDvBlSignalCompatId'
  | 'sourceHdr10Plus'
  | 'tonemapCurve'
>;

/** The session fields the cache profile hash is derived from. The timeline
 *  frozen at playback-info wins, so a rescan mid-playback moves no session. */
export function sessionLayoutContext(
  live: Partial<SessionLayout> | null | undefined,
  si: MediaFileInfo | null | undefined,
  label: string,
): SessionLayoutContext {
  const useTs = live?.useTs ?? false;
  const timeline = live?.timeline ?? sourceTimeline(si, label);
  // Frozen off the LiveSession: a rescan that rewrites track count/order must
  // not desync it from audioPlan/audioTrackPlans, decided against this layout.
  const audioStreams = live?.audioStreams ?? si?.audio ?? undefined;
  return {
    useTs,
    // Multi-audio: video-only segments plus one var_stream_map rendition per
    // track, so the player switches client-side via EXT-X-MEDIA.
    videoOnly: audioLayout(audioStreams?.length ?? 0) === 'var-stream-map',
    // With `streamIndex`, so the single-track path maps `0:<abs>` too.
    audioStreams,
    audioPlan: live?.audioPlan ?? undefined,
    audioTrackPlans: live?.audioTrackPlans ?? undefined,
    // Undefined only before a sid exists (the userId-based findCurrent fallback).
    videoVariant: live?.videoVariant ?? undefined,
    sourceStartPts: timeline.origin,
    sourceFormatStart: timeline.formatStart,
    sourceEndSeconds: timeline.end,
    sourceClockBreakSeconds: timeline.clockBreak,
    sourceVersion: live?.sourceVersion ?? undefined,
    dolbyVision: live?.dolbyVision ?? false,
    tonemap: live?.tonemapping ?? false,
    tonemapCurve: live?.tonemapCurve ?? DEFAULT_TONEMAP_CURVE,
    // Frozen against a stale-probe rescan; a `null` (no DV) profile must not
    // fall through to a re-read, hence the gate on the session itself.
    sourceDvProfile: live
      ? (live.sourceDvProfile ?? undefined)
      : si?.video?.[0]?.dvProfile,
    sourceDvBlSignalCompatId: live
      ? (live.sourceDvBlSignalCompatId ?? undefined)
      : si?.video?.[0]?.dvBlSignalCompatId,
    // Frozen, not re-read from si: a background reprobe fills this in later
    // and must not fork the hash mid-session.
    sourceHdr10Plus: live?.sourceHdr10Plus ?? false,
  } satisfies Record<keyof SessionLayoutContext, unknown>;
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
