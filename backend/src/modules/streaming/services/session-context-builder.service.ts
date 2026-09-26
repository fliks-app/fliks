import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import {
  buildPlaybackProfileFromContext,
  computeProfileHash,
  resolveSourceVideoBitrateBps,
} from '../transcoding';
import type { SessionContext } from '../transcoding';
import { pickAudioLayout } from '../transcoding/audio-layout';
import { parseSourceFps } from '../transcoding/constants';
import { sourceTimeline } from '../transcoding/source-timeline';
import { ActiveStreamTracker } from '../active-stream-tracker.service';
import { SessionRouter } from './session-router.service';
import type { ResolvedFile } from '../streaming.service';
import type { LiveSession } from '../live-session.service';
import type { MediaFileInfo } from '../../subtitles/ffprobe.service';
import { User } from '../../users/entities/user.entity';

/** The session fields the cache profile hash is derived from. playback-info
 *  hashes the session it creates through this too, so the hash it stores is
 *  the one every later transcode request derives. */
export function sessionLayoutContext(
  live:
    | Pick<
        LiveSession,
        'useTs' | 'audioPlan' | 'audioTrackPlans' | 'videoVariant'
      >
    | null
    | undefined,
  si: MediaFileInfo | null | undefined,
): Pick<
  SessionContext,
  | 'useTs'
  | 'videoOnly'
  | 'audioStreams'
  | 'audioPlan'
  | 'audioTrackPlans'
  | 'videoVariant'
> {
  const useTs = live?.useTs ?? false;
  return {
    useTs,
    // Multi-audio: produce video-only segments and let ffmpeg's var_stream_map
    // emit one audio rendition per track (subdirs 1..N) so Shaka can switch
    // client-side via EXT-X-MEDIA.
    videoOnly:
      pickAudioLayout(si?.audio?.length ?? 0, useTs ? 'ts' : 'fmp4') ===
      'var-stream-map',
    // Always plumb the audio streams (incl. `streamIndex`) so the single-track
    // path can also resolve `-map 0:<abs>` and skip FFmpeg's audio enumeration.
    audioStreams: si?.audio ?? undefined,
    // Canonical audio decision, computed once in stream-builder.
    audioPlan: live?.audioPlan ?? undefined,
    audioTrackPlans: live?.audioTrackPlans ?? undefined,
    // Variant chosen by stream-builder's codec selector; undefined only before
    // a sid exists (routes through the userId-based findCurrent fallback).
    videoVariant: live?.videoVariant ?? undefined,
  };
}

/** Cache profile hash of a session, as `computeProfileHashForCtx` derives it
 *  from the context {@link SessionContextBuilder.build} returns for it. */
export function sessionProfileHash(
  live: Parameters<typeof sessionLayoutContext>[0],
  si: MediaFileInfo | null | undefined,
  segmentDurationSeconds: number,
): string {
  return computeProfileHash(
    buildPlaybackProfileFromContext(
      sessionLayoutContext(live, si),
      segmentDurationSeconds * 1000,
    ),
  );
}

/**
 * Assembles the SessionContext a transcode/segment route hands to the
 * transcoder. Everything codec/quality-related is read back from the LiveSession
 * (frozen by stream-builder at playback-info time) so respawns and quality
 * switches stay coherent with what playback-info promised; only the intrinsic
 * source facts (dimensions, fps, audio streams) come straight off streamInfo.
 */
@Injectable()
export class SessionContextBuilder {
  constructor(
    private readonly activeStreamTracker: ActiveStreamTracker,
    private readonly sessionRouter: SessionRouter,
  ) {}

  build(
    req: Request,
    resolved: ResolvedFile,
    mediaFileId: number,
  ): SessionContext {
    const user = req.user as User | undefined;
    const si = resolved.mediaFile.streamInfo;
    const live = this.sessionRouter.findRequestSession(req, mediaFileId);
    const timeline = sourceTimeline(si, resolved.absolutePath);
    return {
      ...sessionLayoutContext(live, si),
      userId: user?.id,
      username: user?.username,
      instanceSuffix: live?.instanceId ?? undefined,
      mediaTitle: resolved.media?.title,
      mediaType: resolved.media?.type,
      posterUrl: resolved.media?.posterUrl ?? null,
      transcodeReasons: live?.transcodeReasons ?? [],
      tonemap: live?.tonemapping ?? false,
      burnInSubtitle: live?.burnIn ?? undefined,
      audioStreamIndex: live?.audioStreamIndex ?? undefined,
      // Honour the admin auto-crop toggle: when off, never feed a crop to the
      // ffmpeg filter graph, so even a session that transcodes for another
      // reason keeps the black bars instead of cropping them.
      crop: this.activeStreamTracker.getAutoCropEnabled()
        ? (si?.video?.[0]?.crop ?? undefined)
        : undefined,
      deviceType: live?.deviceType ?? 'desktop',
      encoderPreset: live?.encoderPreset ?? 'faster',
      tonemapAlgo: this.activeStreamTracker.getTonemapAlgo(),
      // Source framerate (e.g. "24", "23.976", "29.97") — used to compute an
      // accurate GOP so IDR frames fall on the same boundary regardless of
      // source fps. Falls back to 24 when unknown.
      sourceFps: parseSourceFps(si?.video?.[0]?.frameRate),
      sourceStartPts: timeline.origin,
      sourceFormatStart: timeline.formatStart,
      sourceEndSeconds:
        si?.durationSeconds != null
          ? timeline.formatStart + si.durationSeconds
          : undefined,
      videoStreamIndex: si?.video?.[0]?.streamIndex,
      // Source colorimetry — preserved through an SDR transcode so the output
      // signals the source's real matrix/primaries/transfer, not a forced BT.709.
      sourceColorSpace: si?.video?.[0]?.colorSpace,
      sourceColorPrimaries: si?.video?.[0]?.colorPrimaries,
      sourceColorTransfer: si?.video?.[0]?.colorTransfer,
      sourceColorRange: si?.video?.[0]?.colorRange,
      // Admin segment-duration setting, snapshotted here and frozen onto the
      // session at spawn so the serve/seek grid never shifts under a live
      // session if the admin later changes it.
      segmentDuration: this.activeStreamTracker.getSegmentDuration(),
      // ffprobe ran at import/rescan and the result is cached in streamInfo —
      // tell FFmpeg to skip its own redundant avformat_find_stream_info scan.
      trustedStreamInfo: !!si?.video?.[0]?.codec,
      sourceVideoCodec:
        (si?.video?.[0]?.codec ?? '').toLowerCase() || undefined,
      sourceHasBFrames: si?.video?.[0]?.hasBFrames,
      sourceWidth: si?.video?.[0]?.width,
      sourceHeight: si?.video?.[0]?.height,
      sourceVideoBitrateBps: resolveSourceVideoBitrateBps(
        si?.video?.[0]?.bitRate,
        si?.formatBitRate,
        (si?.audio ?? []).reduce((sum, a) => sum + (a?.bitRate ?? 0), 0),
      ),
      isSourceHdr: !!si?.video?.[0]?.hdrFormat,
      hdrMetadata: si?.video?.[0]?.hdrMetadata,
      sourceDvProfile: si?.video?.[0]?.dvProfile,
      sourceDvBlSignalCompatId: si?.video?.[0]?.dvBlSignalCompatId,
    };
  }
}
