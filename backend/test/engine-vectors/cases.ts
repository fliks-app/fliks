import type { DeviceProfileDto } from '../../src/modules/streaming/dto/device-profile.dto';
import type { MediaFileInfo } from '../../src/modules/media-probe/ffprobe.service';
import { HOST_CAPS } from './host-caps';
import {
  DEFAULT_CONFIG,
  wireDevice,
  wireInfo,
  wireScan,
  type Vector,
  type VectorConfig,
  type VectorInput,
} from './vector';

const dev = (d: unknown): DeviceProfileDto => d as DeviceProfileDto;

/** Device profiles as the web, Apple, Android TV, low-end mobile, Cast and mpv clients send them. */
export const DEVICES: Record<string, DeviceProfileDto> = {
  'web-chrome': dev({
    deviceType: 'desktop',
    deviceName: 'Chrome',
    systemName: 'Linux',
    directPlayProfiles: [
      {
        containers: ['mp4', 'webm'],
        videoCodecs: ['h264', 'vp9', 'av1'],
        audioCodecs: ['aac', 'mp3', 'opus', 'flac'],
      },
    ],
    codecConditions: [
      {
        codec: 'h264',
        maxLevel: 52,
        profiles: ['baseline', 'main', 'high'],
        maxBitDepth: 8,
      },
      { codec: 'av1', maxBitDepth: 10 },
    ],
    maxAudioChannels: 2,
    supportsHdr: false,
    supportsDirectPlay: true,
    supportsAbr: true,
    supportsHlsSubtitles: false,
    switchesDirectPlayAudio: false,
  }),
  'safari-tvos': dev({
    deviceType: 'desktop',
    deviceName: 'Apple TV',
    systemName: 'tvOS',
    directPlayProfiles: [
      {
        containers: ['mp4', 'mov', 'm4v'],
        videoCodecs: ['hevc', 'h264'],
        audioCodecs: ['aac', 'ac3', 'eac3', 'mp3', 'flac', 'alac'],
      },
    ],
    codecConditions: [
      {
        codec: 'hevc',
        maxLevel: 153,
        profiles: ['main', 'main 10'],
        maxBitDepth: 10,
        maxWidth: 3840,
        maxHeight: 2160,
      },
      {
        codec: 'h264',
        maxLevel: 52,
        profiles: ['main', 'high'],
        maxBitDepth: 8,
        maxWidth: 3840,
        maxHeight: 2160,
      },
    ],
    maxAudioChannels: 8,
    audioChannelsByCodec: { eac3: 6, ac3: 6, aac: 8 },
    supportsHdr: true,
    supportsDolbyVision: true,
    dolbyVisionProfiles: [5, 8],
    supportsDirectPlay: true,
    switchesDirectPlayAudio: false,
    supportsHlsSubtitles: true,
    needsHlsSubtitles: true,
    supportsAbr: true,
    supportsMuxedAudioRendition: true,
    supportsIFrameTrickPlay: true,
    dedupesAudioByLanguage: true,
  }),
  'android-tv': dev({
    deviceType: 'desktop',
    deviceName: 'Shield TV',
    systemName: 'Android',
    directPlayProfiles: [
      {
        containers: ['mp4', 'mkv', 'webm'],
        videoCodecs: ['h264', 'hevc', 'vp9', 'av1'],
        audioCodecs: ['aac', 'ac3', 'eac3', 'mp3', 'opus', 'flac', 'dts'],
      },
    ],
    codecConditions: [
      {
        codec: 'hevc',
        maxLevel: 153,
        maxBitDepth: 10,
        maxWidth: 3840,
        maxHeight: 2160,
      },
      {
        codec: 'h264',
        maxLevel: 52,
        maxBitDepth: 8,
        maxWidth: 3840,
        maxHeight: 2160,
      },
      { codec: 'av1', maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160 },
    ],
    maxAudioChannels: 6,
    supportsHdr: true,
    supportsDolbyVision: true,
    dolbyVisionProfiles: [8],
    supportsDirectPlay: true,
    supportsAbr: true,
    maxStreamingBitrate: 100_000_000,
  }),
  'lowend-h264-mobile': dev({
    deviceType: 'mobile',
    deviceName: 'Budget phone',
    systemName: 'Android',
    directPlayProfiles: [
      {
        containers: ['mp4'],
        videoCodecs: ['h264'],
        audioCodecs: ['aac', 'mp3'],
      },
    ],
    codecConditions: [
      {
        codec: 'h264',
        maxLevel: 40,
        profiles: ['baseline', 'main'],
        maxBitDepth: 8,
        maxWidth: 1920,
        maxHeight: 1080,
      },
    ],
    maxAudioChannels: 2,
    supportsHdr: false,
    supportsDirectPlay: true,
    supportsAbr: false,
    maxStreamingBitrate: 8_000_000,
  }),
  cast: dev({
    deviceType: 'desktop',
    deviceName: 'Chromecast with Google TV',
    systemName: 'Cast',
    directPlayProfiles: [
      {
        containers: ['mp4'],
        videoCodecs: ['h264', 'hevc'],
        audioCodecs: ['aac', 'ac3', 'eac3', 'mp3'],
      },
    ],
    codecConditions: [
      {
        codec: 'hevc',
        maxLevel: 153,
        maxBitDepth: 10,
        maxWidth: 3840,
        maxHeight: 2160,
      },
      { codec: 'h264', maxLevel: 52, maxBitDepth: 8 },
    ],
    maxAudioChannels: 6,
    supportsHdr: true,
    supportsDolbyVision: true,
    dolbyVisionProfiles: [5, 8],
    supportsDirectPlay: true,
    switchesDirectPlayAudio: false,
    needsHlsSubtitles: true,
    useTs: true,
  }),
  'desktop-mpv': dev({
    deviceType: 'desktop',
    deviceName: 'mpv',
    systemName: 'Windows',
    directPlayProfiles: [
      {
        containers: ['mkv', 'mp4', 'webm'],
        videoCodecs: ['h264', 'hevc', 'av1', 'vp9'],
        audioCodecs: [
          'aac',
          'ac3',
          'eac3',
          'dts',
          'truehd',
          'flac',
          'opus',
          'mp3',
        ],
      },
    ],
    maxAudioChannels: 8,
    supportsHdr: false,
    tonemapsHdrLocally: true,
    cropsBlackBarsLocally: true,
    dolbyVisionProfiles: [5, 8],
    supportsDirectPlay: true,
  }),
};

const V = {
  streamIndex: 0,
  profile: 'High',
  level: 41,
  width: 1920,
  height: 1080,
  displayAspectRatio: '16:9',
  pixelFormat: 'yuv420p',
  frameRate: '24000/1001',
  avgFrameRate: '24000/1001',
  reorderFrames: 2,
  startTimeSeconds: 0,
  firstFrameSeconds: 0,
  endSeconds: 5400,
  bitDepth: 8,
  colorSpace: 'bt709',
  colorTransfer: 'bt709',
  colorPrimaries: 'bt709',
  colorRange: 'tv',
};
const HDR10 = {
  colorSpace: 'bt2020nc',
  colorTransfer: 'smpte2084',
  colorPrimaries: 'bt2020',
  hdrFormat: 'HDR10' as const,
  hdrMetadata: {
    masteringDisplay:
      'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)',
    maxCll: 1000,
    maxFall: 400,
  },
  hdr10Plus: false,
};
const A = (streamIndex: number, o: Record<string, unknown>) => ({
  streamIndex,
  language: 'eng',
  sampleRate: 48000,
  startTimeSeconds: 0,
  endSeconds: 5400,
  ...o,
});
const SUBS = [
  {
    streamIndex: 20,
    codec: 'subrip',
    language: 'eng',
    forced: false,
    hearingImpaired: false,
    isImageBased: false,
  },
  {
    streamIndex: 21,
    codec: 'hdmv_pgs_subtitle',
    language: 'eng',
    forced: false,
    hearingImpaired: false,
    isImageBased: true,
  },
];
const base = (o: Partial<MediaFileInfo>): MediaFileInfo =>
  ({
    subtitles: SUBS,
    formatStartSeconds: 0,
    durationSeconds: 5400,
    timestampBreakSeconds: null,
    ...o,
  }) as MediaFileInfo;

export interface Media {
  ext: string;
  contentType: string;
  info: MediaFileInfo;
}
const mkv = 'video/x-matroska';
const mp4 = 'video/mp4';

export const MEDIA: Record<string, Media> = {
  'h264-sdr-mkv': {
    ext: '.mkv',
    contentType: mkv,
    info: base({
      formatName: 'matroska,webm',
      formatBitRate: 8_700_000,
      video: [{ ...V, codec: 'h264', bitRate: 8_000_000 }],
      audio: [
        A(1, {
          codec: 'eac3',
          channels: 6,
          channelLayout: '5.1(side)',
          bitRate: 640_000,
          isDefault: true,
        }),
      ],
    } as never),
  },
  'hevc-hdr10-mkv': {
    ext: '.mkv',
    contentType: mkv,
    info: base({
      formatName: 'matroska,webm',
      formatBitRate: 42_000_000,
      video: [
        {
          ...V,
          ...HDR10,
          codec: 'hevc',
          profile: 'Main 10',
          level: 153,
          width: 3840,
          height: 2160,
          pixelFormat: 'yuv420p10le',
          bitDepth: 10,
          bitRate: 38_000_000,
        },
      ],
      audio: [
        A(1, {
          codec: 'eac3',
          channels: 6,
          channelLayout: '5.1(side)',
          bitRate: 768_000,
          isDefault: true,
          profile: 'Dolby Digital Plus + Dolby Atmos',
        }),
      ],
    } as never),
  },
  'dv-p81-mp4': {
    ext: '.mp4',
    contentType: mp4,
    info: base({
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      formatBitRate: 30_000_000,
      video: [
        {
          ...V,
          ...HDR10,
          codec: 'hevc',
          profile: 'Main 10',
          level: 153,
          width: 3840,
          height: 2160,
          pixelFormat: 'yuv420p10le',
          bitDepth: 10,
          bitRate: 28_000_000,
          dvProfile: 8,
          dvBlSignalCompatId: 1,
          dvLevel: 6,
          dvRpuPresent: true,
          dvBlPresent: true,
          dvElPresent: false,
        },
      ],
      audio: [
        A(1, {
          codec: 'eac3',
          channels: 6,
          channelLayout: '5.1(side)',
          bitRate: 640_000,
          isDefault: true,
        }),
      ],
    } as never),
  },
  'dv-p7-mkv': {
    ext: '.mkv',
    contentType: mkv,
    info: base({
      formatName: 'matroska,webm',
      formatBitRate: 60_000_000,
      video: [
        {
          ...V,
          ...HDR10,
          codec: 'hevc',
          profile: 'Main 10',
          level: 153,
          width: 3840,
          height: 2160,
          pixelFormat: 'yuv420p10le',
          bitDepth: 10,
          bitRate: 55_000_000,
          dvProfile: 7,
          dvBlSignalCompatId: 6,
          dvLevel: 7,
          dvRpuPresent: true,
          dvBlPresent: true,
          dvElPresent: true,
        },
      ],
      audio: [
        A(1, {
          codec: 'truehd',
          channels: 8,
          channelLayout: '7.1',
          isDefault: true,
          profile: 'Dolby TrueHD + Dolby Atmos',
        }),
        A(2, {
          codec: 'ac3',
          channels: 6,
          channelLayout: '5.1(side)',
          bitRate: 640_000,
        }),
      ],
    } as never),
  },
  'dv-p5-mp4': {
    ext: '.mp4',
    contentType: mp4,
    info: base({
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      formatBitRate: 25_000_000,
      video: [
        {
          ...V,
          codec: 'hevc',
          profile: 'Main 10',
          level: 150,
          width: 3840,
          height: 2160,
          pixelFormat: 'yuv420p10le',
          bitDepth: 10,
          bitRate: 24_000_000,
          colorSpace: undefined,
          colorTransfer: undefined,
          colorPrimaries: undefined,
          dvProfile: 5,
          dvBlSignalCompatId: 0,
          dvLevel: 6,
          dvRpuPresent: true,
          dvBlPresent: true,
          dvElPresent: false,
        },
      ],
      audio: [
        A(1, { codec: 'eac3', channels: 6, bitRate: 640_000, isDefault: true }),
      ],
    } as never),
  },
  'av1-10bit-mkv': {
    ext: '.mkv',
    contentType: mkv,
    info: base({
      formatName: 'matroska,webm',
      formatBitRate: 5_000_000,
      video: [
        {
          ...V,
          codec: 'av1',
          profile: 'Main',
          level: 8,
          pixelFormat: 'yuv420p10le',
          bitDepth: 10,
          bitRate: 4_600_000,
        },
      ],
      audio: [
        A(1, { codec: 'opus', channels: 2, bitRate: 128_000, isDefault: true }),
      ],
    } as never),
  },
  'hevc-4k-highbitrate-mkv': {
    ext: '.mkv',
    contentType: mkv,
    info: base({
      formatName: 'matroska,webm',
      formatBitRate: 82_000_000,
      video: [
        {
          ...V,
          codec: 'hevc',
          profile: 'Main 10',
          level: 153,
          width: 3840,
          height: 2160,
          pixelFormat: 'yuv420p10le',
          bitDepth: 10,
          bitRate: 78_000_000,
        },
      ],
      audio: [
        A(1, {
          codec: 'dts',
          channels: 6,
          channelLayout: '5.1(side)',
          bitRate: 1_509_000,
          isDefault: true,
          profile: 'DTS-HD MA',
        }),
      ],
    } as never),
  },
  'multi-audio-truehd-ac3': {
    ext: '.mkv',
    contentType: mkv,
    info: base({
      formatName: 'matroska,webm',
      formatBitRate: 30_000_000,
      video: [{ ...V, codec: 'h264', bitRate: 20_000_000 }],
      audio: [
        A(1, {
          codec: 'truehd',
          channels: 8,
          channelLayout: '7.1',
          isDefault: true,
        }),
        A(2, {
          codec: 'ac3',
          channels: 6,
          channelLayout: '5.1(side)',
          bitRate: 640_000,
        }),
        A(3, { codec: 'aac', channels: 2, language: 'fra', bitRate: 192_000 }),
        A(4, {
          codec: 'aac',
          channels: 2,
          commentary: true,
          bitRate: 128_000,
          title: 'Commentary',
        }),
      ],
    } as never),
  },
  'h264-1080p-scope-crop-mkv': {
    ext: '.mkv',
    contentType: mkv,
    info: base({
      formatName: 'matroska,webm',
      formatBitRate: 12_000_000,
      video: [
        {
          ...V,
          codec: 'h264',
          bitRate: 11_000_000,
          crop: { width: 1920, height: 800, x: 0, y: 140 },
        },
      ],
      audio: [
        A(1, { codec: 'aac', channels: 2, bitRate: 192_000, isDefault: true }),
      ],
    } as never),
  },
  'hevc-1080p-hlg-mp4': {
    ext: '.mp4',
    contentType: mp4,
    info: base({
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      formatBitRate: 20_000_000,
      video: [
        {
          ...V,
          codec: 'hevc',
          profile: 'Main 10',
          level: 150,
          pixelFormat: 'yuv420p10le',
          bitDepth: 10,
          bitRate: 19_000_000,
          colorSpace: 'bt2020nc',
          colorTransfer: 'arib-std-b67',
          colorPrimaries: 'bt2020',
          hdrFormat: 'HLG',
        },
      ],
      audio: [
        A(1, { codec: 'aac', channels: 2, bitRate: 256_000, isDefault: true }),
      ],
    } as never),
  },
  'mpegts-h264-aac': {
    ext: '.ts',
    contentType: 'video/mp2t',
    info: base({
      formatName: 'mpegts',
      formatBitRate: 9_000_000,
      formatStartSeconds: 1.4,
      video: [
        {
          ...V,
          codec: 'h264',
          level: 40,
          bitRate: 7_500_000,
          startTimeSeconds: 1.4,
          firstFrameSeconds: 1.48,
          endSeconds: 3600,
        },
      ],
      audio: [
        A(1, {
          codec: 'aac',
          channels: 6,
          channelLayout: '5.1',
          bitRate: 384_000,
          startTimeSeconds: 1.4,
          endSeconds: 3600,
          isDefault: true,
        }),
      ],
      subtitles: [],
      durationSeconds: 3600,
    } as never),
  },
};

const TS_SCAN = (changed: boolean) =>
  wireScan({
    keyframes: Array.from({ length: 12 }, (_, i) => ({
      pts: 1.48 + i * 300,
      dts: 1.48 + i * 300 - 0.08,
    })),
    end: 3600,
    audioConfigChanges: { 1: changed },
  });

interface Sel {
  label: string;
  selection: VectorInput['selection'];
}
const SELECTIONS: Record<string, Sel> = {
  auto: { label: 'auto', selection: { tokenParam: '?token=t' } },
  original: {
    label: 'original',
    selection: { tokenParam: '?token=t', requestedQuality: 'original' },
  },
  '720p': {
    label: '720p',
    selection: { tokenParam: '?token=t', requestedQuality: '720p' },
  },
  'audio-1': {
    label: 'audio idx 1',
    selection: { tokenParam: '?token=t', audioStreamIndex: 1 },
  },
  'burnin-image': {
    label: 'burn-in image',
    selection: {
      tokenParam: '?token=t',
      burnInSubtitleId: 7,
      burnInIsText: false,
    },
  },
  'burnin-text': {
    label: 'burn-in text',
    selection: {
      tokenParam: '?token=t',
      burnInSubtitleId: 7,
      burnInIsText: true,
    },
  },
};

const CAPS = ['cpu', 'vaapi', 'nvenc', 'videotoolbox'] as const;

function make(
  device: string,
  media: string,
  caps: string,
  sel: string,
  config: Partial<VectorConfig> = {},
  tag = '',
  scan: VectorInput['scan'] = null,
): Vector {
  const m = MEDIA[media];
  const s = SELECTIONS[sel];
  return {
    name: `${device} ${media} ${caps} ${s.label}${tag ? ' ' + tag : ''}`,
    source: 'synthetic',
    input: {
      media: {
        mediaFileId: 1,
        path: `/media/${media}${m.ext}`,
        ext: m.ext,
        contentType: m.contentType,
      },
      info: wireInfo(m.info),
      scan,
      device: wireDevice(DEVICES[device]),
      selection: s.selection,
    },
    hostCaps: HOST_CAPS[caps],
    config: { ...DEFAULT_CONFIG, ...config },
  };
}

/** Synthetic matrix, pruned by hand: the full device x media x host grid on auto, then the
 *  selections and config knobs only where they move the decision. */
export function syntheticVectors(): Vector[] {
  const out: Vector[] = [];
  const devices = Object.keys(DEVICES);
  const core = Object.keys(MEDIA).filter(
    (m) =>
      ![
        'mpegts-h264-aac',
        'hevc-1080p-hlg-mp4',
        'h264-1080p-scope-crop-mkv',
      ].includes(m),
  );

  // 1. auto on every device x core media x host.
  for (const d of devices)
    for (const m of core) for (const c of CAPS) out.push(make(d, m, c, 'auto'));

  // 2. selections: original and a lower rung on cpu (+vaapi for HDR/DV), burn-in and audio pick on cpu+nvenc.
  for (const d of devices) {
    for (const m of [
      'h264-sdr-mkv',
      'hevc-hdr10-mkv',
      'dv-p81-mp4',
      'hevc-4k-highbitrate-mkv',
    ]) {
      for (const s of ['original', '720p']) out.push(make(d, m, 'cpu', s));
      if (m.includes('hdr10') || m.includes('p81'))
        out.push(make(d, m, 'vaapi', '720p'));
    }
    for (const c of ['cpu', 'nvenc']) {
      for (const s of ['burnin-image', 'burnin-text'])
        out.push(make(d, 'h264-sdr-mkv', c, s));
      out.push(make(d, 'hevc-hdr10-mkv', c, 'burnin-image'));
      out.push(make(d, 'multi-audio-truehd-ac3', c, 'audio-1'));
    }
  }

  // 3. crop (admin toggle on) x local-crop client, HLG, broadcast TS with each scan outcome.
  for (const d of ['web-chrome', 'android-tv', 'desktop-mpv']) {
    for (const c of ['cpu', 'vaapi']) {
      out.push(
        make(
          d,
          'h264-1080p-scope-crop-mkv',
          c,
          'auto',
          { autoCropEnabled: true },
          'crop on',
        ),
      );
      out.push(
        make(
          d,
          'h264-1080p-scope-crop-mkv',
          c,
          'auto',
          { autoCropEnabled: false },
          'crop off',
        ),
      );
    }
  }
  for (const d of devices) {
    for (const c of ['cpu', 'vaapi'])
      out.push(make(d, 'hevc-1080p-hlg-mp4', c, 'auto'));
  }
  for (const d of ['web-chrome', 'safari-tvos', 'android-tv']) {
    out.push(make(d, 'mpegts-h264-aac', 'cpu', 'auto', {}, 'no scan'));
    out.push(
      make(
        d,
        'mpegts-h264-aac',
        'cpu',
        'auto',
        {},
        'scan stable',
        TS_SCAN(false),
      ),
    );
    out.push(
      make(
        d,
        'mpegts-h264-aac',
        'cpu',
        'auto',
        {},
        'scan changes',
        TS_SCAN(true),
      ),
    );
  }

  // 4. config knobs: ABR auto mode, tonemap algo pins, on HDR/DV media.
  for (const d of devices) {
    for (const m of ['h264-sdr-mkv', 'hevc-hdr10-mkv'])
      out.push(make(d, m, 'cpu', 'auto', { autoQualityMode: 'abr' }, 'abr'));
  }
  for (const algo of ['vaapi', 'opencl', 'qsv'] as const) {
    for (const m of ['hevc-hdr10-mkv', 'dv-p5-mp4']) {
      for (const c of ['vaapi', 'vaapi-no-opencl', 'qsv'])
        out.push(
          make(
            'web-chrome',
            m,
            c,
            'auto',
            { tonemapAlgo: algo },
            `tonemap ${algo}`,
          ),
        );
    }
  }
  for (const m of ['hevc-hdr10-mkv', 'dv-p5-mp4', 'dv-p81-mp4']) {
    out.push(make('web-chrome', m, 'vaapi-no-opencl', 'auto'));
    out.push(make('web-chrome', m, 'qsv', 'auto'));
  }
  return out;
}
