/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- decide fixtures are untyped JSON */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { remuxRunStart } from '../../src/modules/streaming/transcoding/ffmpeg-args';
import {
  DESKTOP_HDR_PROFILES,
  DESKTOP_PROFILES,
  ECO_HDR_PROFILES,
  ECO_PROFILES,
  hdrRungName,
  resolveLadderRung,
  sourceBitrates,
} from '../../src/modules/streaming/transcoding/profiles';
import { sourceTimeline } from '../../src/modules/streaming/transcoding/source-timeline';
import { parseSourceFps } from '../../src/modules/streaming/transcoding/constants';
import { encodePipelineInputs } from '../../src/modules/streaming/transcoding/encode-pipeline';
import type { TonemapCurve } from '../../src/modules/streaming/transcoding/codec/types';
import { DEFAULT_ENV, type ArgvVector } from './argv-vector';
import { HOST_CAPS, type HostCaps } from './host-caps';
import type { Vector } from './vector';

type Obj = Record<string, any>;

const caps = (over: Partial<HostCaps>): HostCaps => ({
  ...HOST_CAPS.cpu,
  ...over,
});

/** The other backend each decide fixture is also built on, in rotation. */
const ALT_CAPS: [string, HostCaps][] = [
  ['vaapi', HOST_CAPS.vaapi],
  ['qsv', HOST_CAPS.qsv],
  ['nvenc', HOST_CAPS.nvenc],
  ['videotoolbox', HOST_CAPS.videotoolbox],
  [
    'amf-win32',
    caps({
      hwAccel: 'amf',
      platform: 'win32',
      probes: ['amfOpencl', 'opencl', 'openclHdr10'],
    }),
  ],
  [
    'qsv-win32',
    caps({
      hwAccel: 'qsv',
      platform: 'win32',
      probes: ['qsvOpencl', 'qsvOpenclHdr10', 'vppQsv'],
    }),
  ],
  ['vaapi-no-opencl', HOST_CAPS['vaapi-no-opencl']],
  [
    'qsv-vpp',
    caps({
      hwAccel: 'qsv',
      probes: ['vppQsv', 'tonemapOpenclCrop'],
      libfdkAac: true,
    }),
  ],
  [
    'nvenc-opencl',
    caps({ hwAccel: 'nvenc', probes: ['opencl', 'openclHdr10'] }),
  ],
  [
    'qsv-vaapi-hdr',
    caps({ hwAccel: 'qsv', vaapiWritesHdrMetadata: true, probes: ['vulkan'] }),
  ],
];

const CURVES: (TonemapCurve | undefined)[] = [
  undefined,
  'hable',
  'reinhard',
  'mobius',
];

function audioStreams(info: Obj): Obj[] {
  return (info.audio ?? []).map((a: Obj) => ({
    language: a.language,
    streamIndex: a.streamIndex,
    channels: a.channels,
  }));
}

/** Session options of a Transcode decision, as `buildArgsOptionsFromCtx` assembles them. */
function vodOptions(f: Vector, hostCaps: HostCaps, n: number): Obj {
  const d = f.expected as Obj;
  const r = d.response as Obj;
  const info = f.input.info as Obj;
  const v0: Obj = info.video?.[0] ?? {};
  const sel = f.input.selection;
  const tl = sourceTimeline(info as never);
  const ladder = d.useHdrLadder
    ? [...DESKTOP_HDR_PROFILES, ...ECO_HDR_PROFILES]
    : [...DESKTOP_PROFILES, ...ECO_PROFILES];
  const profile =
    resolveLadderRung(
      hdrRungName(r.quality as string, !!d.useHdrLadder),
      ladder,
    ) ?? ladder[n % 4];
  const audio = audioStreams(info);
  const multi = audio.length > 1;
  const sourceVideoCodec =
    ((v0.codec as string) ?? '').toLowerCase() || undefined;
  const burnIn = !sel.burnInSubtitleId
    ? undefined
    : sel.burnInIsText
      ? { type: 'text', filter: "subtitles='/subs/1.srt'" }
      : {
          type: 'image',
          streamIndex:
            (info.subtitles ?? []).find((s: Obj) => s.isImageBased)
              ?.streamIndex ?? 3,
        };
  const crop = f.config.autoCropEnabled ? v0.crop : undefined;
  const tonemap = !!d.transcodeTonemapping;
  return {
    inputPath: f.input.media.path,
    outputDir: `/cache/transcode/${f.input.media.mediaFileId}/${profile.name}`,
    profile,
    hwAccel: hostCaps.hwAccel,
    videoOnly: multi,
    audioStreams: audio,
    tonemap,
    burnIn,
    audioStreamIndex: sel.audioStreamIndex,
    crop,
    audioPlan:
      (d.audioPlans as Obj[])[sel.audioStreamIndex ?? 0] ?? r.audioPlan,
    audioTrackPlans: multi ? d.audioPlans : undefined,
    sourceStartPts: tl.origin,
    sourceFormatStart: tl.formatStart,
    sourceEndSeconds: tl.end,
    sourceClockBreakSeconds: tl.clockBreak,
    videoStreamIndex: v0.streamIndex,
    encoderPreset: 'faster',
    tonemapAlgo: f.config.tonemapAlgo,
    tonemapCurve: CURVES[n % CURVES.length],
    sourceFps: parseSourceFps(v0.frameRate as string | undefined),
    sourceColorSpace: v0.colorSpace,
    sourceColorPrimaries: v0.colorPrimaries,
    sourceColorTransfer: v0.colorTransfer,
    sourceColorRange: v0.colorRange,
    segmentDuration: f.config.segmentDuration,
    trustedStreamInfo: !!v0.codec,
    useTs: d.muxFlavour === 'ts',
    videoVariant: d.videoVariant,
    sourceVideoCodec,
    sourceVideoBitrateBps: sourceBitrates(info as never).videoBitRate,
    sourceBitDepth: encodePipelineInputs({
      hwAccel: hostCaps.hwAccel,
      crop: !!crop,
      textBurnIn: !!burnIn?.filter,
      tonemap,
      tonemapAlgo: f.config.tonemapAlgo,
      sourceVideoCodec,
      isSourceHdr: !!v0.hdrFormat,
      sourceDvProfile: v0.dvProfile,
      sourceDvBlSignalCompatId: v0.dvBlSignalCompatId,
    }).sourceBitDepth,
    sourceWidth: v0.width,
    sourceHeight: v0.height,
    sourceHdrMetadata: v0.hdrMetadata,
    sourceDvProfile: v0.dvProfile,
    sourceDvBlSignalCompatId: v0.dvBlSignalCompatId,
  };
}

function remuxOptions(f: Vector, start: number): Obj {
  const d = f.expected as Obj;
  const r = d.response as Obj;
  const info = f.input.info as Obj;
  const v0: Obj = info.video?.[0] ?? {};
  const tl = sourceTimeline(info as never);
  const audio = audioStreams(info);
  const multi = audio.length > 1;
  const sel = f.input.selection;
  return {
    inputPath: f.input.media.path,
    outputDir: `/cache/remux/${f.input.media.mediaFileId}/run-${start}`,
    run: remuxRunStart(null, start, f.config.segmentDuration, tl.origin),
    trustedStreamInfo: !!v0.codec,
    audioStreamIndex: sel.audioStreamIndex,
    sourceVideoCodec: ((v0.codec as string) ?? '').toLowerCase() || undefined,
    audioStreams: audio,
    grid: null,
    segmentDuration: f.config.segmentDuration,
    videoStreamIndex: v0.streamIndex,
    sourceEndSeconds: tl.end,
    sourceClockBreakSeconds: tl.clockBreak,
    audioPlan:
      (d.audioPlans as Obj[])[sel.audioStreamIndex ?? 0] ?? r.audioPlan,
    audioTrackPlans: multi ? d.audioPlans : undefined,
    videoOnly: multi,
    dolbyVision: !!r.dolbyVision,
    sourceDvProfile: v0.dvProfile,
    sourceDvBlSignalCompatId: v0.dvBlSignalCompatId,
    hdr10Plus: !!v0.hdr10Plus,
  };
}

/** Transcode decide fixtures as VOD runs, DirectStream ones as remux runs. */
function decideMatrix(engineRepo: string): ArgvVector[] {
  const dir = join(engineRepo, 'fixtures', 'decide');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const out: ArgvVector[] = [];
  files.forEach((file, n) => {
    const f = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Vector;
    const method = ((f.expected as Obj).response as Obj).playMethod;
    const base = file.replace(/\.json$/, '');
    if (method === 'Transcode') {
      const [altName, alt] = ALT_CAPS[n % ALT_CAPS.length];
      const hosts: [string, HostCaps][] = [
        ['own', f.hostCaps],
        [altName, alt],
      ];
      for (const [hostName, hostCaps] of hosts)
        for (const [start, early] of [
          [0, false],
          [7, false],
          [7, true],
        ] as const)
          out.push({
            name: `vod ${base} on ${hostName} seg ${start}${early ? ' early' : ''}`,
            source: 'synthetic',
            kind: 'vod',
            hostCaps,
            env: DEFAULT_ENV,
            input: {
              ...vodOptions(f, hostCaps, n),
              startSegment: start,
              early,
            },
          });
    } else if (method === 'DirectStream') {
      for (const start of [0, 7])
        out.push({
          name: `remux ${base} seg ${start}`,
          source: 'synthetic',
          kind: 'remux',
          hostCaps: f.hostCaps,
          env: DEFAULT_ENV,
          input: remuxOptions(f, start),
        });
    }
  });
  return out;
}

const LIVE_HW = [
  'none',
  'qsv',
  'vaapi',
  'nvenc',
  'amf',
  'videotoolbox',
] as const;

function liveMatrix(): ArgvVector[] {
  const out: ArgvVector[] = [];
  let n = 0;
  for (const hwAccel of LIVE_HW)
    for (const mode of ['remux', 'transcode'] as const)
      for (const useTs of [false, true])
        for (const audioCodec of ['aac', 'mp2', null]) {
          n++;
          const platform =
            hwAccel === 'amf' || (hwAccel === 'qsv' && n % 2)
              ? 'win32'
              : 'linux';
          out.push({
            name: `live ${hwAccel} ${mode} ${useTs ? 'ts' : 'fmp4'} ${audioCodec} ${n}`,
            source: 'synthetic',
            kind: 'live',
            hostCaps: caps({
              hwAccel,
              platform: hwAccel === 'videotoolbox' ? 'darwin' : platform,
            }),
            env:
              n % 4 === 0
                ? { ...DEFAULT_ENV, renderNode: '/dev/dri/renderD129' }
                : DEFAULT_ENV,
            input: {
              inputUrl: `http://provider.example/live/${n}.ts`,
              outputDir: `/cache/live/${n}`,
              segmentSeconds: [2, 4, 6][n % 3],
              windowMinutes: [5, 30, 0][n % 3],
              mode,
              useTs,
              hwAccel,
              ...(n % 5 === 0 ? { videoBitrateBps: 2_500_000 } : {}),
              ...(audioCodec ? { audioCodec } : {}),
              ...(n % 3 === 0 ? { append: true } : {}),
              ...(n % 7 === 0 ? { probeSeconds: 8 } : {}),
              ...(n % 6 === 0
                ? { userAgent: 'Kodi/20', referer: 'http://ref.example/' }
                : {}),
            },
          });
        }
  return out;
}

export function syntheticArgvVectors(engineRepo: string): ArgvVector[] {
  return [...decideMatrix(engineRepo), ...liveMatrix()];
}
