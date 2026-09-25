import { StreamBuilderService } from './stream-builder.service';
import type { DeviceProfileDto } from './dto/device-profile.dto';

const svc = () =>
  new StreamBuilderService(
    { getDetectedHwAccel: () => 'none' } as never,
    { getAutoCropEnabled: () => false, getTonemapAlgo: () => 'auto' } as never,
  );

const client: DeviceProfileDto = {
  directPlayProfiles: [
    { containers: ['mkv'], videoCodecs: ['hevc'], audioCodecs: ['aac'] },
  ],
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
} as never;

const resolvedWith = (audio: { startTimeSeconds?: number }[]) =>
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
            startTimeSeconds: 0,
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
describe('StreamBuilderService — separate-rendition audio start offset', () => {
  it('forces an offset multi-audio track to transcode instead of copy', () => {
    const r = svc().evaluate(
      resolvedWith([{ startTimeSeconds: 0 }, { startTimeSeconds: 1 }]),
      client,
      'tok',
      undefined,
      'eco-1080p',
    );
    expect(r.response.playMethod).toBe('Transcode');
    const tracks = r.response.audioTracks!;
    expect(tracks[0].copy).toBe(true);
    expect(tracks[1].copy).toBe(false);
    expect(tracks[1].reasonFlags).toContain('AudioStartOffset');
    expect(tracks[1].outputCodec).toBe('aac');
  });

  it('keeps an offset within the encoder-priming noise floor as a copy', () => {
    const r = svc().evaluate(
      resolvedWith([{ startTimeSeconds: 0 }, { startTimeSeconds: 0.01 }]),
      client,
      'tok',
      undefined,
      'eco-1080p',
    );
    const tracks = r.response.audioTracks!;
    expect(tracks[1].copy).toBe(true);
    expect(tracks[1].reasonFlags).not.toContain('AudioStartOffset');
  });

  it('ignores an offset on a single-audio source (inline layout, no separate rendition)', () => {
    const r = svc().evaluate(
      resolvedWith([{ startTimeSeconds: 1 }]),
      client,
      'tok',
      undefined,
      'eco-1080p',
    );
    const tracks = r.response.audioTracks!;
    expect(tracks[0].copy).toBe(true);
    expect(tracks[0].reasonFlags).not.toContain('AudioStartOffset');
  });

  it('leaves the offset track copied when startTimeSeconds is unknown', () => {
    const r = svc().evaluate(
      resolvedWith([{ startTimeSeconds: 0 }, {}]),
      client,
      'tok',
      undefined,
      'eco-1080p',
    );
    const tracks = r.response.audioTracks!;
    expect(tracks[1].copy).toBe(true);
    expect(tracks[1].reasonFlags).not.toContain('AudioStartOffset');
  });
});
