import { StreamBuilderService } from './stream-builder.service';
import type { DeviceProfileDto } from './dto/device-profile.dto';

const svc = () =>
  new StreamBuilderService(
    { getDetectedHwAccel: () => 'none' } as never,
    {
      getAutoCropEnabled: () => false,
      getTonemapAlgo: () => 'auto',
      getSegmentDuration: () => 3,
    } as never,
  );

const profileWith = (
  audioCodecs: string[],
  extra: Partial<DeviceProfileDto> = {},
  containers = ['mkv'],
): DeviceProfileDto =>
  ({
    directPlayProfiles: [{ containers, videoCodecs: ['hevc'], audioCodecs }],
    codecConditions: [
      {
        codec: 'hevc',
        profiles: ['main'],
        maxBitDepth: 8,
        maxWidth: 3840,
        maxHeight: 2160,
        maxLevel: 180,
      },
    ],
    supportsHdr: false,
    supportsDirectPlay: true,
    maxAudioChannels: 6,
    ...extra,
  }) as never;

const client = profileWith(['aac']);

type Track = { startTimeSeconds?: number; codec?: string; channels?: number };

const resolvedWith = (audio: Track[], videoStart: number | null = 0) =>
  ({
    ext: '.mkv',
    contentType: 'video/x-matroska',
    absolutePath: '/m/in.mkv',
    relativePath: 'in.mkv',
    size: 1,
    media: { title: 'X', type: 'movie' },
    mediaFile: {
      id: 1,
      streamInfo: {
        video: [
          {
            codec: 'hevc',
            width: 1920,
            height: 1080,
            bitDepth: 8,
            profile: 'Main',
            level: 120,
            bitRate: 8_000_000,
            frameRate: '24',
            startTimeSeconds: videoStart ?? undefined,
          },
        ],
        audio: audio.map((a) => ({
          codec: 'aac',
          channels: 2,
          bitRate: 128_000,
          ...a,
        })),
        durationSeconds: 100,
      },
    },
  }) as never;

// 'eco-1080p' forces the Transcode ladder regardless of copy-compatibility
// (see negotiated-quality.spec.ts), so the per-track audio decision runs.
const transcode = (audio: Track[], profile = client, videoStart: number | null = 0) =>
  svc().evaluate(
    resolvedWith(audio, videoStart),
    profile,
    'tok',
    undefined,
    'eco-1080p',
  ).response;

describe('StreamBuilderService — audio start offset', () => {
  it('forces an offset multi-audio track to transcode instead of copy', () => {
    const r = transcode([{ startTimeSeconds: 0 }, { startTimeSeconds: 1 }]);
    expect(r.playMethod).toBe('Transcode');
    const tracks = r.audioTracks!;
    expect(tracks[0].copy).toBe(true);
    expect(tracks[1].copy).toBe(false);
    expect(tracks[1].reasonFlags).toEqual(['AudioStartOffset']);
    expect(tracks[1].outputCodec).toBe('aac');
  });

  it('keeps the source channels of a track re-encoded only for its offset', () => {
    const r = transcode([
      { startTimeSeconds: 0, channels: 6 },
      { startTimeSeconds: 1, channels: 6 },
    ]);
    const t = r.audioTracks![1];
    expect(t.copy).toBe(false);
    expect(t.outputChannels).toBe(6);
    expect(t.reasonFlags).not.toContain('AudioChannelsNotSupported');
  });

  it('keeps an offset at the threshold as a copy and forces one just above', () => {
    const at = transcode([{ startTimeSeconds: 0 }, { startTimeSeconds: 0.05 }]);
    expect(at.audioTracks![1].copy).toBe(true);
    const above = transcode([{ startTimeSeconds: 0 }, { startTimeSeconds: 0.051 }]);
    expect(above.audioTracks![1].copy).toBe(false);
  });

  it('keeps an offset within the encoder-priming noise floor as a copy', () => {
    const r = transcode([{ startTimeSeconds: 0 }, { startTimeSeconds: 0.021 }]);
    expect(r.audioTracks![1].copy).toBe(true);
    expect(r.audioTracks![1].reasonFlags).not.toContain('AudioStartOffset');
  });

  it('forces a single offset track on the inline layout, keeping its codec and channels', () => {
    const r = transcode([{ startTimeSeconds: 1, channels: 6 }]);
    expect(r.audioTracks![0].copy).toBe(false);
    expect(r.audioCopyStream).toBe(false);
    expect(r.audioPlan).toEqual({
      mode: 'transcode',
      codec: 'aac',
      bitrateBps: expect.any(Number),
      channels: 6,
    });
    expect(r.transcodeReasons.map((x) => x.flag)).toContain('AudioStartOffset');
  });

  it('routes the remux copy decision through the same predicate', () => {
    // Container outside the profile → DirectStream (remux) with a copyable video.
    const r = svc().evaluate(
      resolvedWith([{ startTimeSeconds: 1, codec: 'eac3', channels: 6 }]),
      profileWith(['eac3'], {}, ['mp4']),
      'tok',
    ).response;
    expect(r.playMethod).toBe('DirectStream');
    expect(r.audioCopyStream).toBe(false);
    expect(r.audioPlan).toEqual({
      mode: 'transcode',
      codec: 'eac3',
      bitrateBps: expect.any(Number),
      channels: 6,
    });
    expect(r.transcodeReasons.map((x) => x.flag)).toContain('AudioStartOffset');
  });

  it('moves an all-FLAC group with an offset track to an encodable codec', () => {
    const flac = profileWith(['aac', 'flac']);
    const r = transcode(
      [
        { startTimeSeconds: 0, codec: 'flac' },
        { startTimeSeconds: 1, codec: 'flac' },
      ],
      flac,
    );
    const tracks = r.audioTracks!;
    expect(tracks.map((t) => t.outputCodec)).toEqual(['aac', 'aac']);
    expect(tracks.every((t) => !t.copy)).toBe(true);
    expect(tracks[1].reasonFlags).toContain('AudioStartOffset');
  });

  it('copies an all-FLAC group when every track starts with the video', () => {
    const r = transcode(
      [
        { startTimeSeconds: 0, codec: 'flac' },
        { startTimeSeconds: 0, codec: 'flac' },
      ],
      profileWith(['aac', 'flac']),
    );
    expect(r.audioTracks!.every((t) => t.copy && t.outputCodec === 'flac')).toBe(true);
  });

  it('does not force MPEG-TS output, which keeps each track at its own PTS', () => {
    const r = transcode(
      [{ startTimeSeconds: 0 }, { startTimeSeconds: 1 }],
      profileWith(['aac'], { useTs: true }),
    );
    expect(r.audioTracks![1].copy).toBe(true);
  });

  it('leaves the track copied when the audio start is unknown', () => {
    const r = transcode([{ startTimeSeconds: 0 }, {}]);
    expect(r.audioTracks![1].copy).toBe(true);
    expect(r.audioTracks![1].reasonFlags).not.toContain('AudioStartOffset');
  });

  it('leaves every track copied when the video start is unknown', () => {
    const r = transcode(
      [{ startTimeSeconds: 1 }, { startTimeSeconds: 1 }],
      client,
      null,
    );
    expect(r.audioTracks!.every((t) => t.copy)).toBe(true);
    expect(r.audioCopyStream).toBe(true);
  });
});
