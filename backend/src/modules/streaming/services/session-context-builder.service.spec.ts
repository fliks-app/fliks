import type { Request } from 'express';
import { SessionContextBuilder } from './session-context-builder.service';
import { sessionProfileHash } from '../transcoding/session-profile';
import { LiveSessionRegistry } from '../live-session.service';
import {
  buildPlaybackProfileFromContext,
  computeProfileHash,
} from '../transcoding';
import type { ResolvedFile } from '../streaming.service';

function resolved(audioCount: number): ResolvedFile {
  return {
    absolutePath: '/media/film.mkv',
    media: { title: 'T', type: 'movie', posterUrl: null },
    mediaFile: {
      streamInfo: {
        video: [{ codec: 'hevc', width: 3840, height: 2160, frameRate: '24' }],
        audio: Array.from({ length: audioCount }, (_, i) => ({
          language: `l${i}`,
          bitRate: 128000,
        })),
        formatBitRate: 50_000_000,
      },
    },
  } as unknown as ResolvedFile;
}

const req = { user: { id: 7, username: 'u' } } as unknown as Request;

describe('SessionContextBuilder.build', () => {
  let sessionRouter: { findRequestSession: jest.Mock };
  let tracker: {
    getTonemapAlgo: jest.Mock;
    getAutoCropEnabled: jest.Mock;
    getSegmentDuration: jest.Mock;
  };
  let builder: SessionContextBuilder;

  beforeEach(() => {
    sessionRouter = { findRequestSession: jest.fn().mockReturnValue(null) };
    tracker = {
      getTonemapAlgo: jest.fn().mockReturnValue('auto'),
      getAutoCropEnabled: jest.fn().mockReturnValue(true),
      getSegmentDuration: jest.fn().mockReturnValue(3),
    };
    builder = new SessionContextBuilder(tracker as never, sessionRouter as never);
  });

  it('sets videoOnly (var_stream_map) only for multi-audio sources', () => {
    expect(builder.build(req, resolved(2), 1).videoOnly).toBe(true);
    expect(builder.build(req, resolved(1), 1).videoOnly).toBe(false);
    expect(builder.build(req, resolved(0), 1).videoOnly).toBe(false);
  });

  it('carries the intrinsic source facts off streamInfo', () => {
    const ctx = builder.build(req, resolved(1), 1);
    expect(ctx.sourceWidth).toBe(3840);
    expect(ctx.sourceHeight).toBe(2160);
    expect(ctx.sourceVideoCodec).toBe('hevc');
    expect(ctx.sourceFps).toBe(24);
    expect(ctx.userId).toBe(7);
  });

  it('anchors on the first presented frame and seeks from the container start', () => {
    const r = resolved(1);
    Object.assign(r.mediaFile.streamInfo!, {
      formatStartSeconds: 14.94,
      video: [{ streamIndex: 1, codec: 'h264', startTimeSeconds: 15, firstFrameSeconds: 15.8 }],
    });
    const ctx = builder.build(req, r, 1);
    expect(ctx.sourceStartPts).toBe(15.8);
    expect(ctx.sourceFormatStart).toBe(14.94);
    expect(ctx.videoStreamIndex).toBe(1);
  });

  it('snapshots the admin segment duration onto the context', () => {
    tracker.getSegmentDuration.mockReturnValue(6);
    expect(builder.build(req, resolved(1), 1).segmentDuration).toBe(6);
  });

  it('gates the crop on the auto-crop toggle', () => {
    const cropRect = { width: 3840, height: 1606, x: 0, y: 277 };
    const withCrop = {
      absolutePath: '/media/film.mkv',
      media: { title: 'T', type: 'movie', posterUrl: null },
      mediaFile: {
        streamInfo: {
          video: [
            { codec: 'hevc', width: 3840, height: 2160, frameRate: '24', crop: cropRect },
          ],
          audio: [{ language: 'en', bitRate: 128000 }],
          formatBitRate: 50_000_000,
        },
      },
    } as unknown as ResolvedFile;

    tracker.getAutoCropEnabled.mockReturnValue(true);
    expect(builder.build(req, withCrop, 1).crop).toEqual(cropRect);

    tracker.getAutoCropEnabled.mockReturnValue(false);
    expect(builder.build(req, withCrop, 1).crop).toBeUndefined();
  });

  it('threads the frozen decision off the LiveSession when present', () => {
    sessionRouter.findRequestSession.mockReturnValue({
      tonemapping: true,
      deviceType: 'mobile',
      useTs: true,
      videoVariant: { codec: 'av1', bitDepth: 10, hdr: 'HDR10' },
      audioPlan: { mode: 'copy', codec: 'eac3' },
    });
    const ctx = builder.build(req, resolved(1), 1);
    expect(ctx.tonemap).toBe(true);
    expect(ctx.deviceType).toBe('mobile');
    expect(ctx.useTs).toBe(true);
    expect(ctx.videoVariant).toEqual({ codec: 'av1', bitDepth: 10, hdr: 'HDR10' });
    expect(ctx.audioPlan).toEqual({ mode: 'copy', codec: 'eac3' });
  });

  it('falls back to safe defaults with no LiveSession', () => {
    const ctx = builder.build(req, resolved(1), 1);
    expect(ctx.tonemap).toBe(false);
    expect(ctx.deviceType).toBe('desktop');
    expect(ctx.useTs).toBe(false);
    expect(ctx.videoVariant).toBeUndefined();
  });

  it('keeps the timeline frozen at playback-info through a rescan', () => {
    const registry = new LiveSessionRegistry();
    const live = registry.create({
      userId: 7,
      username: 'u',
      kind: 'transcode',
      mediaFileId: 1,
      timeline: { origin: 2.8, formatStart: 2.779, end: 60, clockBreak: 40 },
    });
    sessionRouter.findRequestSession.mockReturnValue(live);
    const rescanned = resolved(1);
    const ctx = builder.build(req, rescanned, 1);
    expect(ctx.sourceStartPts).toBe(2.8);
    expect(ctx.sourceFormatStart).toBe(2.779);
    expect(ctx.sourceEndSeconds).toBe(60);
    expect(ctx.sourceClockBreakSeconds).toBe(40);
    registry.onModuleDestroy();
  });

  it('hashes a var_stream_map session at playback-info as every transcode request does', () => {
    const file = resolved(2);
    const layout = (outputChannels: number) => ({
      useTs: false,
      audioPlan: { mode: 'copy' as const, codec: 'aac' },
      audioTrackPlans: [
        { copy: true, outputCodec: 'aac', outputChannels: 2 },
        { copy: false, outputCodec: 'aac', outputChannels },
      ],
      videoVariant: { codec: 'h264' as const, bitDepth: 8 as const, hdr: null },
    });
    const registry = new LiveSessionRegistry();
    const live = registry.create({
      userId: 7,
      username: 'u',
      kind: 'transcode',
      mediaFileId: 1,
      profileHash: sessionProfileHash(
        layout(2),
        file.mediaFile.streamInfo,
        'f',
        3,
      ),
      ...layout(2),
    });
    sessionRouter.findRequestSession.mockReturnValue(live);
    const ctx = builder.build(req, file, 1);
    expect(ctx.videoOnly).toBe(true);
    // What TranscodingService.computeProfileHashForCtx derives for this context.
    const requestHash = computeProfileHash(
      buildPlaybackProfileFromContext(ctx, ctx.segmentDuration! * 1000),
    );
    expect(live.profileHash).toBe(requestHash);
    expect(
      sessionProfileHash(layout(6), file.mediaFile.streamInfo, 'f', 3),
    ).not.toBe(requestHash);
    registry.onModuleDestroy();
  });
});
