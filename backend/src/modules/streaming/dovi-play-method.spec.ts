import type { DeviceProfileDto } from './dto/device-profile.dto';
import { makeStreamBuilder as svc } from './stream-builder.test-helpers';

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

// DV-capable client that can NOT raw-play MKV (iOS AVPlayer: mp4/mov only), so a
// DV-in-MKV source can't DirectPlay and would otherwise fall to a remux copy.
const dvMp4OnlyClient: DeviceProfileDto = {
  containers: ['mp4'],
  directPlayProfiles: [
    { containers: ['mp4'], videoCodecs: ['hevc'], audioCodecs: ['aac'] },
  ],
  codecConditions: [
    { codec: 'hevc', profiles: ['main', 'main 10'], maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxLevel: 180 },
  ],
  supportsHdr: true,
  supportsDirectPlay: true,
  supportsDolbyVision: true,
  maxAudioChannels: 6,
} as never;

// DV+AV1-capable client: proves P10.0 tone-maps even though the client
// could otherwise present DV (it has no compatible base to fall back to).
const dvAv1Client: DeviceProfileDto = {
  containers: ['mkv'],
  directPlayProfiles: [
    { containers: ['mkv'], videoCodecs: ['av1'], audioCodecs: ['aac'] },
  ],
  codecConditions: [
    { codec: 'av1', maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160 },
  ],
  supportsHdr: true,
  supportsDirectPlay: true,
  supportsDolbyVision: true,
  maxAudioChannels: 6,
} as never;

// Lists only profile 8, so it still can't present a P5.
const dvProfile8OnlyClient: DeviceProfileDto = {
  ...hdrHevcClient,
  supportsDolbyVision: true,
  dolbyVisionProfiles: [8],
} as never;

// Lists profile 7, so its raw P7 decoder is trusted with the dual-layer file.
const dvProfile7Client: DeviceProfileDto = {
  ...hdrHevcClient,
  supportsDolbyVision: true,
  dolbyVisionProfiles: [7],
} as never;

// Windows desktop mpv: lists P5 but has no HDR display, so it tone-maps itself.
const dvProfile5NoHdrClient: DeviceProfileDto = {
  ...hdrHevcClient,
  supportsHdr: false,
  dolbyVisionProfiles: [5],
} as never;

// Lists profile 10 and can't raw-play MKV, so a P10.0 AV1 source remuxes.
const dvProfile10Av1Client: DeviceProfileDto = {
  containers: ['mp4'],
  directPlayProfiles: [
    { containers: ['mp4'], videoCodecs: ['av1'], audioCodecs: ['aac'] },
  ],
  codecConditions: [
    { codec: 'av1', maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160 },
  ],
  supportsHdr: true,
  supportsDirectPlay: true,
  supportsDolbyVision: true,
  dolbyVisionProfiles: [10],
  maxAudioChannels: 6,
} as never;

const resolved = (
  dvProfile?: number,
  dvBlSignalCompatId?: number,
  dvElPresent?: boolean,
  dvLevel?: number,
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
            colorRange: 'tv',
            colorSpace: 'bt2020nc',
            pixelFormat: 'yuv420p10le',
            dvProfile,
            dvBlSignalCompatId,
            dvElPresent,
            dvLevel,
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
    const r = svc().evaluate(resolved(5, 0, undefined, 6), dvHevcClient, 'tok');
    expect(r.response.playMethod).toBe('DirectPlay');
    expect(r.response.videoCopyStream).toBe(true);
    expect(r.response.tonemapping).toBe(false);
    expect(r.response.dolbyVision).toBe(true);
    expect(
      r.response.transcodeReasons.some((x) => /Dolby Vision/.test(x.message)),
    ).toBe(false);
  });

  it('DirectPlays a level-less P5 for a DV client that can raw-play the container', () => {
    // No probed dvLevel: DirectPlay ships raw bytes and needs no CODECS string.
    const r = svc().evaluate(resolved(5, 0, undefined, undefined), dvHevcClient, 'tok');
    expect(r.response.playMethod).toBe('DirectPlay');
    expect(r.response.qualities?.some((q) => q.id === 'original')).toBe(true);
  });

  it('transcodes a level-less P5 for a DV client that cannot raw-play the container', () => {
    // No level means no CODECS string, so the remux path is unavailable too.
    const r = svc().evaluate(resolved(5, 0, undefined, undefined), dvMp4OnlyClient, 'tok');
    expect(r.response.playMethod).toBe('Transcode');
  });

  it('DirectPlays P5 with RPU-only metadata (no HDR VUI) for a DV client', () => {
    const r: any = resolved(5, 0, undefined, 6);
    r.mediaFile.streamInfo.video[0].hdrFormat = undefined;
    r.mediaFile.streamInfo.video[0].colorTransfer = undefined;
    r.mediaFile.streamInfo.video[0].colorPrimaries = undefined;
    const out = svc().evaluate(r, dvHevcClient, 'tok');
    expect(out.response.playMethod).toBe('DirectPlay');
    expect(out.response.videoCopyStream).toBe(true);
  });

  it('remuxes P5 (standalone CODECS) for a DV client that cannot raw-play the container', () => {
    // iOS-style: MKV source can't DirectPlay, but a DV client with a probed
    // level gets a `dvh1` remux tagged with the standalone CODECS string.
    const r = svc().evaluate(resolved(5, 0, undefined, 6), dvMp4OnlyClient, 'tok');
    expect(r.response.playMethod).toBe('DirectStream');
    expect(r.response.dolbyVision).toBe(true);
  });

  it('transcodes P10.0 (no compatible base) with the dovi tonemap for an HDR AV1 client', () => {
    const r: any = resolved(10, 0);
    const v0 = r.mediaFile.streamInfo.video[0];
    v0.codec = 'av1';
    v0.hdrFormat = undefined;
    v0.colorTransfer = undefined;
    v0.colorPrimaries = undefined;
    const out = svc().evaluate(r, dvAv1Client, 'tok');
    expect(out.response.playMethod).toBe('Transcode');
    expect(out.response.tonemapping).toBe(true);
    expect(out.response.dolbyVision).toBe(false);
  });

  it('remuxes DV 8.1 with dolbyVision:true for a DV client that cannot raw-play the container', () => {
    const r = svc().evaluate(resolved(8, 1, undefined, 6), dvMp4OnlyClient, 'tok');
    expect(r.response.playMethod).toBe('DirectStream');
    expect(r.response.dolbyVision).toBe(true);
  });

  it('never flags dolbyVision for an HDR-only client (no DV declared)', () => {
    const r = svc().evaluate(resolved(8, 1, undefined, 6), hdrHevcClient, 'tok');
    expect(r.response.dolbyVision).toBeFalsy();
  });

  it('forces P5 to transcode for a client that lists only profile 8', () => {
    const r = svc().evaluate(resolved(5, 0, undefined, 6), dvProfile8OnlyClient, 'tok');
    expect(r.response.playMethod).toBe('Transcode');
    expect(r.response.tonemapping).toBe(true);
  });

  it('remuxes raw P7 to HDR10 base for an HDR client that does not list profile 7', () => {
    const r = svc().evaluate(resolved(7, 6, true, 6), dvHevcClient, 'tok');
    expect(r.response.playMethod).toBe('DirectStream');
    expect(r.response.dolbyVision).toBeFalsy();
  });

  it('DirectPlays raw P7 for a client that lists profile 7', () => {
    const r = svc().evaluate(resolved(7, 6, true, 6), dvProfile7Client, 'tok');
    expect(r.response.playMethod).toBe('DirectPlay');
  });

  it('DirectPlays P5 with clientTonemap true for a client with no HDR display', () => {
    const r = svc().evaluate(resolved(5, 0, undefined, 6), dvProfile5NoHdrClient, 'tok');
    expect(r.response.playMethod).toBe('DirectPlay');
    expect(r.response.clientTonemap).toBe(true);
  });

  it('still DirectPlays raw P7 to a non-P7 client when Direct Stream is disabled', () => {
    // No remux to fall back to (canCopyVideo false), so the P7 gate must not
    // fire: DirectPlay stays rather than forcing a 4K re-encode.
    const r = svc().evaluate(
      resolved(7, 6, true, 6),
      dvHevcClient,
      'tok',
      undefined,
      undefined,
      'directplay',
      undefined,
      undefined,
      undefined,
      false,
    );
    expect(r.response.playMethod).toBe('DirectPlay');
  });

  it('remuxes P10.0 (dav1.10.LL standalone) for a client that lists profile 10', () => {
    const r: any = resolved(10, 0, undefined, 8);
    const v0 = r.mediaFile.streamInfo.video[0];
    v0.codec = 'av1';
    v0.hdrFormat = undefined;
    v0.colorTransfer = undefined;
    v0.colorPrimaries = undefined;
    const out = svc().evaluate(r, dvProfile10Av1Client, 'tok');
    expect(out.response.playMethod).toBe('DirectStream');
    expect(out.response.dolbyVision).toBe(true);
  });
});
