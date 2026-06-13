import type { Request } from 'express';
import { SessionContextBuilder } from './session-context-builder.service';
import type { ResolvedFile } from '../streaming.service';

function resolved(audioCount: number): ResolvedFile {
  return {
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
  let tracker: { getQsvOptions: jest.Mock; getTonemapAlgo: jest.Mock };
  let builder: SessionContextBuilder;

  beforeEach(() => {
    sessionRouter = { findRequestSession: jest.fn().mockReturnValue(null) };
    tracker = {
      getQsvOptions: jest.fn().mockReturnValue({ lowPower: false }),
      getTonemapAlgo: jest.fn().mockReturnValue('auto'),
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
});
