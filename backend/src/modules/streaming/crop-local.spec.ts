import { StreamBuilderService } from './stream-builder.service';
import type { DeviceProfileDto } from './dto/device-profile.dto';

const svc = () =>
  new StreamBuilderService(
    { getDetectedHwAccel: () => 'none' } as never,
    { getAutoCropEnabled: () => true, getTonemapAlgo: () => 'auto' } as never,
  );

const client: DeviceProfileDto = {
  directPlayProfiles: [
    { containers: ['mkv'], videoCodecs: ['hevc'], audioCodecs: ['aac'] },
  ],
  codecConditions: [
    {
      codec: 'hevc',
      profiles: ['main', 'main 10'],
      maxBitDepth: 10,
      maxWidth: 3840,
      maxHeight: 2160,
      maxLevel: 180,
    },
  ],
  supportsHdr: false,
  supportsDirectPlay: true,
  maxAudioChannels: 6,
} as never;

const croppingClient: DeviceProfileDto = {
  ...client,
  cropsBlackBarsLocally: true,
};

/** 2160p HEVC with black bars — cropdetect found a 3840x1648 active area. */
const resolved = () =>
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
            width: 3840,
            height: 2160,
            bitDepth: 8,
            profile: 'Main',
            level: 150,
            bitRate: 20_000_000,
            frameRate: '24',
            crop: { width: 3840, height: 1648, x: 0, y: 256 },
          },
        ],
        audio: [{ codec: 'aac', channels: 2, bitRate: 128_000 }],
        durationSeconds: 100,
      },
    },
  }) as never;

const hasCropReason = (r: { response: { transcodeReasons: { flag: string }[] } }) =>
  r.response.transcodeReasons.some((x) => x.flag === 'VideoCrop');

describe('StreamBuilderService — client-side black-bar crop', () => {
  it('re-encodes a cropped source for a client that cannot crop', () => {
    const r = svc().evaluate(resolved(), client, 'tok');
    expect(r.response.playMethod).toBe('Transcode');
    expect(hasCropReason(r)).toBe(true);
  });

  it('DirectPlays it for a client that crops at its own output', () => {
    const r = svc().evaluate(resolved(), croppingClient, 'tok');
    expect(r.response.playMethod).toBe('DirectPlay');
    expect(r.response.videoCopyStream).toBe(true);
    expect(hasCropReason(r)).toBe(false);
    // The rectangle the client applies.
    expect(r.response.source.crop).toEqual({
      width: 3840,
      height: 1648,
      x: 0,
      y: 256,
    });
  });

  it('leaves another transcode reason alone — the server still crops there', () => {
    const burnIn = svc().evaluate(resolved(), croppingClient, 'tok', 7);
    expect(burnIn.response.playMethod).toBe('Transcode');
    expect(burnIn.response.videoCopyStream).toBe(false);

    const lowerRung = svc().evaluate(resolved(), croppingClient, 'tok', undefined, '1080p');
    expect(lowerRung.response.playMethod).toBe('Transcode');
    expect(lowerRung.response.videoCopyStream).toBe(false);
  });
});
