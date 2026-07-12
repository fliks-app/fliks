import { StreamBuilderService } from './stream-builder.service';
import type { DeviceProfileDto } from './dto/device-profile.dto';

const svc = () =>
  new StreamBuilderService(
    { getDetectedHwAccel: () => 'none' } as never,
    { getAutoCropEnabled: () => false, getTonemapAlgo: () => 'auto' } as never,
  );

const hdrHevcClient: DeviceProfileDto = {
  containers: ['mkv'],
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
  supportsHdr: true,
  supportsDirectPlay: true,
  maxAudioChannels: 6,
} as never;

const dvHevcClient: DeviceProfileDto = {
  ...hdrHevcClient,
  supportsDolbyVision: true,
} as never;

const resolved = (
  dvProfile?: number,
  dvBlSignalCompatId?: number,
  dvElPresent?: boolean,
) =>
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
            dvProfile,
            dvBlSignalCompatId,
            dvElPresent,
          },
        ],
        audio: [{ codec: 'aac', channels: 2, bitRate: 128_000 }],
        durationSeconds: 100,
      },
    },
  }) as never;

describe('StreamBuilderService — Dolby Vision play-method', () => {
  it('forces P5 to a tonemapping transcode with an SDR output variant', () => {
    const r = svc().evaluate(resolved(5, 0), hdrHevcClient, 'tok');
    expect(r.response.playMethod).toBe('Transcode');
    expect(r.videoVariant?.hdr).toBeNull();
    expect(r.response.tonemapping).toBe(true);
    expect(
      r.response.transcodeReasons.some((x) => /Dolby Vision/.test(x.message)),
    ).toBe(true);
  });

  it('forces P5 even with no HDR VUI (RPU-only metadata)', () => {
    // Strip the HDR color tags so isSourceHdr would be false — dvP5 must still
    // force the transcode on its own.
    const r: any = resolved(5, 0);
    r.mediaFile.streamInfo.video[0].hdrFormat = undefined;
    r.mediaFile.streamInfo.video[0].colorTransfer = undefined;
    r.mediaFile.streamInfo.video[0].colorPrimaries = undefined;
    const out = svc().evaluate(r, hdrHevcClient, 'tok');
    expect(out.response.playMethod).toBe('Transcode');
    expect(out.videoVariant?.hdr).toBeNull();
    expect(out.response.tonemapping).toBe(true);
  });

  it('leaves DV 8.1 (HDR10-compatible base) on its HDR path', () => {
    const r = svc().evaluate(resolved(8, 1), hdrHevcClient, 'tok');
    expect(
      r.response.transcodeReasons.some((x) => /Dolby Vision/.test(x.message)),
    ).toBe(false);
    expect(r.response.tonemapping).toBe(false);
  });

  it('DirectPlays P5 untouched for a client that can present DV', () => {
    const r = svc().evaluate(resolved(5, 0), dvHevcClient, 'tok');
    expect(r.response.playMethod).toBe('DirectPlay');
    expect(r.response.videoCopyStream).toBe(true);
    expect(r.response.tonemapping).toBe(false);
    expect(
      r.response.transcodeReasons.some((x) => /Dolby Vision/.test(x.message)),
    ).toBe(false);
  });

  it('DirectPlays P5 with RPU-only metadata (no HDR VUI) for a DV client', () => {
    const r: any = resolved(5, 0);
    r.mediaFile.streamInfo.video[0].hdrFormat = undefined;
    r.mediaFile.streamInfo.video[0].colorTransfer = undefined;
    r.mediaFile.streamInfo.video[0].colorPrimaries = undefined;
    const out = svc().evaluate(r, dvHevcClient, 'tok');
    expect(out.response.playMethod).toBe('DirectPlay');
    expect(out.response.videoCopyStream).toBe(true);
  });
});
