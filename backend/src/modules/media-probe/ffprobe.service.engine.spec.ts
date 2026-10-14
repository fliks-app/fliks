import { FfprobeService, type MediaFileInfo } from './ffprobe.service';
import type { EngineService } from '../engine/engine.service';

const INFO = {
  video: [
    {
      streamIndex: 0,
      codec: 'h264',
      crop: { width: 1920, height: 800, x: 0, y: 140 },
    },
  ],
  audio: [{ streamIndex: 2, codec: 'aac', language: 'fra', title: 'VF' }],
  subtitles: [
    {
      streamIndex: 3,
      codec: 'subrip',
      language: 'eng',
      forced: false,
      hearingImpaired: true,
      isImageBased: false,
      title: 'SDH',
    },
  ],
  schemaVersion: 1,
  durationSeconds: 120,
};

function make(probe: jest.Mock, enabled = true) {
  const engine = { enabled, probe } as unknown as EngineService;
  return new FfprobeService(engine);
}

describe('FfprobeService with the engine', () => {
  it('returns the engine MediaInfo unchanged, with the tags requested', async () => {
    const probe = jest.fn(async () => ({ ok: true, info: INFO }));
    const out = await make(probe).detectMediaFileInfo('/m/a.mkv');
    expect(out).toBe(INFO);
    expect(probe).toHaveBeenCalledWith('/m/a.mkv', { mkvTags: true });
  });

  it('maps ok:false to the failure result of the TS path', async () => {
    const probe = jest.fn(async () => ({
      ok: false,
      error: 'moov atom not found',
      info: {
        video: [],
        audio: [],
        subtitles: [],
        error: 'moov atom not found',
      },
    }));
    expect(await make(probe).detectMediaFileInfo('/m/a.mp4')).toEqual({
      video: [],
      audio: [],
      subtitles: [],
      error: 'moov atom not found',
    } satisfies MediaFileInfo);
  });

  it('maps a transport failure to the same failure result', async () => {
    const probe = jest
      .fn()
      .mockRejectedValue(new Error('POST /v1/probe -> 400'));
    const out = await make(probe).detectMediaFileInfo('/m/a.mp4');
    expect(out).toEqual({
      video: [],
      audio: [],
      subtitles: [],
      error: 'POST /v1/probe -> 400',
    });
  });

  it('keeps "No streams detected" as a readable file', async () => {
    const info = {
      video: [],
      audio: [],
      subtitles: [],
      error: 'No streams detected',
    };
    const probe = jest.fn(async () => ({ ok: true, info }));
    expect(await make(probe).detectMediaFileInfo('/m/a.bin')).toBe(info);
  });

  it('detectCrop reads video[0].crop and null when there is none', async () => {
    const probe = jest.fn(async () => ({ ok: true, info: INFO }));
    const svc = make(probe);
    expect(await svc.detectCrop('/m/a.mkv', 120, 1920, 1080)).toEqual(
      INFO.video[0].crop,
    );
    expect(probe).toHaveBeenCalledWith('/m/a.mkv', { crop: true });

    const none = jest.fn(async () => ({
      ok: true,
      info: { ...INFO, video: [{ streamIndex: 0 }] },
    }));
    expect(await make(none).detectCrop('/m/a.mkv')).toBeNull();
    const failed = jest.fn(async () => ({ ok: false, error: 'x', info: {} }));
    expect(await make(failed).detectCrop('/m/a.mkv')).toBeNull();
  });

  it('detectEmbeddedSubtitles keeps ok apart from an empty list', async () => {
    const svc = make(jest.fn(async () => ({ ok: true, info: INFO })));
    expect(await svc.detectEmbeddedSubtitles('/m/a.mkv')).toEqual({
      ok: true,
      streams: [
        {
          streamIndex: 3,
          codec: 'subrip',
          language: 'eng',
          forced: false,
          hearingImpaired: true,
          isImageBased: false,
        },
      ],
    });
    const failed = make(
      jest.fn(async () => ({ ok: false, error: 'x', info: {} })),
    );
    expect(await failed.detectEmbeddedSubtitles('/m/a.mkv')).toEqual({
      ok: false,
      streams: [],
    });
  });

  it('detectStreams lists audio and subtitles in stream order', async () => {
    const svc = make(jest.fn(async () => ({ ok: true, info: INFO })));
    expect(await svc.detectStreams('/m/a.mkv')).toEqual([
      {
        streamIndex: 2,
        type: 'audio',
        codec: 'aac',
        language: 'fra',
        title: 'VF',
      },
      {
        streamIndex: 3,
        type: 'subtitle',
        codec: 'subrip',
        language: 'eng',
        title: 'SDH',
      },
    ]);
  });

  it('does not call the engine when it is disabled', async () => {
    const probe = jest.fn();
    const out = await make(probe, false).detectMediaFileInfo(
      '/nonexistent/a.mkv',
    );
    expect(probe).not.toHaveBeenCalled();
    expect(out.error).toBeDefined();
  });
});
