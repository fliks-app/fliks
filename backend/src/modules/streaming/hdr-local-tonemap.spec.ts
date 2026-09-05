import { StreamBuilderService } from './stream-builder.service';
import type { DeviceProfileDto } from './dto/device-profile.dto';

const svc = (autoCrop = false) =>
  new StreamBuilderService(
    { getDetectedHwAccel: () => 'none' } as never,
    {
      getAutoCropEnabled: () => autoCrop,
      getTonemapAlgo: () => 'auto',
    } as never,
  );

// Desktop shell on an SDR panel: decodes HEVC Main 10, no HDR display.
const sdrClient: DeviceProfileDto = {
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

const localTonemapClient: DeviceProfileDto = {
  ...sdrClient,
  tonemapsHdrLocally: true,
};

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
            width: 1920,
            height: 1080,
            bitDepth: 10,
            profile: 'Main 10',
            level: 120,
            bitRate: 8_000_000,
            frameRate: '24',
            hdrFormat: 'HDR10',
            colorTransfer: 'smpte2084',
            colorPrimaries: 'bt2020',
            crop: '1920:800:0:140',
          },
        ],
        audio: [{ codec: 'aac', channels: 2, bitRate: 128_000 }],
        durationSeconds: 100,
      },
    },
  }) as never;

describe('StreamBuilderService — client-side HDR tone-mapping', () => {
  it('tonemaps server-side for an SDR client without the flag', () => {
    const r = svc().evaluate(resolved(), sdrClient, 'tok');
    expect(r.response.playMethod).toBe('Transcode');
    expect(r.response.tonemapping).toBe(true);
    expect(r.response.clientTonemap).toBeFalsy();
  });

  it('DirectPlays HDR for a client that tone-maps locally', () => {
    const r = svc().evaluate(resolved(), localTonemapClient, 'tok');
    expect(r.response.playMethod).toBe('DirectPlay');
    expect(r.response.videoCopyStream).toBe(true);
    expect(r.response.tonemapping).toBe(false);
    expect(r.response.clientTonemap).toBe(true);
  });

  it('keeps HDR through a lower rung instead of tone-mapping server-side', () => {
    const r = svc().evaluate(resolved(), localTonemapClient, 'tok', undefined, '720p-hdr');
    expect(r.response.playMethod).toBe('Transcode');
    expect(r.videoVariant?.hdr).toBe('HDR10');
    expect(r.response.tonemapping).toBe(false);
    expect(r.response.clientTonemap).toBe(true);
  });

  it('keeps HDR through a crop-forced transcode', () => {
    const r = svc(true).evaluate(resolved(), localTonemapClient, 'tok');
    expect(r.response.playMethod).toBe('Transcode');
    expect(r.videoVariant?.hdr).toBe('HDR10');
    expect(r.response.tonemapping).toBe(false);
    expect(r.response.clientTonemap).toBe(true);
  });

  it('still tone-maps a crop-forced transcode for a plain SDR client', () => {
    const r = svc(true).evaluate(resolved(), sdrClient, 'tok');
    expect(r.response.playMethod).toBe('Transcode');
    expect(r.videoVariant?.hdr).toBeNull();
    expect(r.response.tonemapping).toBe(true);
  });
});
