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

/** Same client, but it tone-maps HDR itself — so an HDR source puts the
 *  session on the HDR ladder, where the rung ids carry a `-hdr` suffix. */
const localTonemapClient: DeviceProfileDto = {
  ...client,
  tonemapsHdrLocally: true,
};

const resolved = (hdr: boolean) =>
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
            bitDepth: hdr ? 10 : 8,
            profile: hdr ? 'Main 10' : 'Main',
            level: 120,
            bitRate: 8_000_000,
            frameRate: '24',
            hdrFormat: hdr ? 'HDR10' : undefined,
            colorTransfer: hdr ? 'smpte2084' : undefined,
            colorPrimaries: hdr ? 'bt2020' : undefined,
          },
        ],
        audio: [{ codec: 'aac', channels: 2, bitRate: 128_000 }],
        durationSeconds: 100,
      },
    },
  }) as never;

describe('StreamBuilderService — negotiated quality', () => {
  it('reports the source rung on a copy path', () => {
    const r = svc().evaluate(resolved(false), client, 'tok');
    expect(r.response.playMethod).toBe('DirectPlay');
    expect(r.response.quality).toBe('original');
  });

  it('reports the eco rung it locked in', () => {
    const r = svc().evaluate(resolved(false), client, 'tok', undefined, 'eco-1080p');
    expect(r.response.playMethod).toBe('Transcode');
    expect(r.response.quality).toBe('eco-1080p');
  });

  it('keeps an eco request on the eco rung of the HDR ladder', () => {
    const r = svc().evaluate(
      resolved(true),
      localTonemapClient,
      'tok',
      undefined,
      'eco-1080p',
    );
    expect(r.response.playMethod).toBe('Transcode');
    expect(r.response.quality).toBe('eco-1080p-hdr');
  });

  it('reports auto when nothing is pinned', () => {
    const r = svc().evaluate(resolved(false), client, 'tok', undefined, 'auto', 'abr');
    expect(r.response.playMethod).toBe('Transcode');
    expect(r.response.quality).toBe('auto');
  });
});
