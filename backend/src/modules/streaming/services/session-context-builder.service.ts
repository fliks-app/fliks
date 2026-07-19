import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { resolveSourceVideoBitrateBps } from '../transcoding';
import type { SessionContext } from '../transcoding';
import { pickAudioLayout } from '../transcoding/audio-layout';
import { parseSourceFps } from '../transcoding/constants';
import { ActiveStreamTracker } from '../active-stream-tracker.service';
import { SessionRouter } from './session-router.service';
import type { ResolvedFile } from '../streaming.service';
import { User } from '../../users/entities/user.entity';

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
    // var_stream_map decision: same logic as playback-info — relies on the
    // file's intrinsic audio-stream count, which doesn't drift across sessions.
    const audioCount = si?.audio?.length ?? 0;
    const useTs = live?.useTs ?? false;
    const useMultiAudioLayout =
      pickAudioLayout(audioCount, useTs ? 'ts' : 'fmp4') === 'var-stream-map';
    return {
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
      // Multi-audio: produce video-only segments and let ffmpeg's var_stream_map
      // emit one audio rendition per track (subdirs 1..N) so Shaka can switch
      // client-side via EXT-X-MEDIA.
      videoOnly: useMultiAudioLayout,
      // Always plumb the audio streams (incl. `streamIndex`) so the single-track
      // path can also resolve `-map 0:<abs>` and skip FFmpeg's audio
      // enumeration. `useMultiAudioLayout` only gates the var_stream_map branch,
      // not the presence of the data.
      audioStreams: si?.audio ?? undefined,
      deviceType: live?.deviceType ?? 'desktop',
      useTs,
      encoderPreset: live?.encoderPreset ?? 'faster',
      qsvOptions: this.activeStreamTracker.getQsvOptions(),
      tonemapAlgo: this.activeStreamTracker.getTonemapAlgo(),
      // Source framerate (e.g. "24", "23.976", "29.97") — used to compute an
      // accurate GOP so IDR frames fall on the same boundary regardless of
      // source fps. Falls back to 24 when unknown.
      sourceFps: parseSourceFps(si?.video?.[0]?.frameRate),
      // Source colorimetry — preserved through an SDR transcode so the output
      // signals the source's real matrix/primaries/transfer, not a forced BT.709.
      sourceColorSpace: si?.video?.[0]?.colorSpace,
      sourceColorPrimaries: si?.video?.[0]?.colorPrimaries,
      sourceColorTransfer: si?.video?.[0]?.colorTransfer,
      // Admin segment-duration setting, snapshotted here and frozen onto the
      // session at spawn so the serve/seek grid never shifts under a live
      // session if the admin later changes it.
      segmentDuration: this.activeStreamTracker.getSegmentDuration(),
      // ffprobe ran at import/rescan and the result is cached in streamInfo —
      // tell FFmpeg to skip its own redundant avformat_find_stream_info scan.
      trustedStreamInfo: !!si?.video?.[0]?.codec,
      // Canonical audio decision — computed once in stream-builder, stored on
      // the LiveSession, threaded through here so respawns / quality switches
      // stay coherent with what playback-info promised.
      audioPlan: live?.audioPlan ?? undefined,
      audioTrackPlans: live?.audioTrackPlans ?? undefined,
      sourceVideoCodec:
        (si?.video?.[0]?.codec ?? '').toLowerCase() || undefined,
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
      // Variant chosen by stream-builder's codec selector at playback-info time,
      // threaded through every session spawn so ffmpeg-args resolves the
      // matching encoder descriptor. Undefined only for legacy callers that
      // never sent a sid (they route through the userId-based findCurrent
      // fallback).
      videoVariant: live?.videoVariant ?? undefined,
    };
  }
}
