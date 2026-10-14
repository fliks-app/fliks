/* eslint-disable @typescript-eslint/no-unsafe-return -- JSON.parse clones */
import { createHash } from 'crypto';
import type { DeviceProfileDto } from '../../src/modules/streaming/dto/device-profile.dto';
import type { MediaFileInfo } from '../../src/modules/media-probe/ffprobe.service';
import type { EvaluateInput } from '../../src/modules/streaming/stream-builder.service';
import { makeStreamBuilder } from '../../src/modules/streaming/stream-builder.test-helpers';
import { remuxSegmentGrid } from '../../src/modules/streaming/transcoding/segment-boundaries';
import { sourceTimeline } from '../../src/modules/streaming/transcoding/source-timeline';
import type { SourceScan } from '../../src/modules/streaming/transcoding/source-scan';
import { withHostCaps, type HostCaps } from './host-caps';

/** The admin settings evaluate() reads: the `StreamingConfig` fields of the engine wire type. */
export interface VectorConfig {
  autoCropEnabled: boolean;
  tonemapAlgo: 'auto' | 'opencl' | 'vaapi' | 'qsv';
  autoQualityMode: 'directplay' | 'abr';
  segmentDuration: number;
}

export const DEFAULT_CONFIG: VectorConfig = {
  autoCropEnabled: false,
  tonemapAlgo: 'auto',
  autoQualityMode: 'directplay',
  segmentDuration: 3,
};

export interface VectorInput {
  media: {
    mediaFileId: number;
    path: string;
    ext: string;
    contentType: string;
  };
  info: MediaFileInfo & { schemaVersion: number };
  scan: (SourceScan & { schemaVersion: number }) | null;
  device: DeviceProfileDto;
  selection: {
    tokenParam?: string;
    burnInSubtitleId?: number;
    burnInIsText?: boolean;
    requestedQuality?: string;
    audioStreamIndex?: number;
  };
}

export interface Vector {
  name: string;
  source: string;
  input: VectorInput;
  hostCaps: HostCaps;
  config: VectorConfig;
  expected?: unknown;
}

/** Evaluate exactly as the controller does: the remux grid is derived from the scan, never given. */
export function runVector(v: Vector): unknown {
  const { media, info, scan, device, selection } = v.input;
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  const streamInfo = clone(info);
  const ctlScan = scan ? clone(scan) : null;
  const origin = sourceTimeline(streamInfo, media.path).origin;
  const grid = remuxSegmentGrid(
    ctlScan,
    origin,
    v.config.segmentDuration,
    streamInfo.video?.[0]?.frameRate,
  );
  const input: Omit<EvaluateInput, 'settings'> = {
    resolved: {
      absolutePath: media.path,
      relativePath: media.path,
      size: 0,
      ext: media.ext,
      contentType: media.contentType,
      mediaFile: { id: media.mediaFileId, streamInfo },
      media: {},
    } as never,
    profile: clone(device),
    tokenParam: selection.tokenParam ?? '',
    burnInSubtitleId: selection.burnInSubtitleId,
    burnInIsText: selection.burnInIsText,
    requestedQuality: selection.requestedQuality,
    audioStreamIndex: selection.audioStreamIndex,
    sourceScan: ctlScan,
    remuxGrid: grid,
  };
  const result = withHostCaps(v.hostCaps, () =>
    makeStreamBuilder({ hwAccel: v.hostCaps.hwAccel }).evaluate({
      ...input,
      settings: v.config,
    }),
  );
  return clone(result);
}

export function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === 'object') {
    return Object.fromEntries(
      Object.entries(x as Record<string, unknown>)
        .filter(([, val]) => val !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return x;
}

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);

export const inputHash = (v: Vector): string =>
  createHash('sha1')
    .update(
      JSON.stringify(sortKeys({ i: v.input, h: v.hostCaps, c: v.config })),
    )
    .digest('hex');

// Wire shape of the engine types (api.rs): only these keys survive a round trip.
const DEVICE_KEYS = new Set([
  'directPlayProfiles',
  'codecConditions',
  'maxStreamingBitrate',
  'maxAudioChannels',
  'audioChannelsByCodec',
  'supportsHdr',
  'tonemapsHdrLocally',
  'cropsBlackBarsLocally',
  'supportsDolbyVision',
  'dolbyVisionProfiles',
  'supportsDirectPlay',
  'switchesDirectPlayAudio',
  'supportsHlsSubtitles',
  'dedupesAudioByLanguage',
  'supportsMuxedAudioRendition',
  'supportsIFrameTrickPlay',
  'supportsImageSubtitles',
  'probesSegZero',
  'deviceType',
  'deviceName',
  'systemName',
  'appVersion',
  'useTs',
  'useTsOnSingleAudio',
  'supportsAbr',
  'rejectCopy',
  'needsHlsSubtitles',
]);
const pick = (o: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(
    keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]),
  );

export function wireDevice(d: DeviceProfileDto): DeviceProfileDto {
  const o = d as unknown as Record<string, unknown>;
  const out = Object.fromEntries(
    Object.entries(o).filter(([k, x]) => DEVICE_KEYS.has(k) && x !== undefined),
  );
  out.directPlayProfiles = (d.directPlayProfiles ?? []).map((p) =>
    pick(p as never, ['containers', 'videoCodecs', 'audioCodecs']),
  );
  if (d.codecConditions) {
    out.codecConditions = d.codecConditions.map((c) =>
      pick(c as never, [
        'codec',
        'maxLevel',
        'profiles',
        'maxBitDepth',
        'maxWidth',
        'maxHeight',
      ]),
    );
  }
  return out as never;
}

/** Fills the keys the wire type requires, which hand-written spec inputs leave out. */
export function wireInfo(info: MediaFileInfo): VectorInput['info'] {
  const c = JSON.parse(JSON.stringify(info)) as MediaFileInfo & {
    schemaVersion?: number;
  };
  c.video = (c.video ?? []).map((s, i) => {
    // hdr-local-tonemap.spec writes the crop as a cropdetect string; the type is an object.
    const crop = s.crop as unknown;
    const [width, height, x, y] =
      typeof crop === 'string' ? crop.split(':').map(Number) : [];
    return {
      ...s,
      streamIndex: s.streamIndex ?? i,
      codec: s.codec ?? '',
      ...(typeof crop === 'string' ? { crop: { width, height, x, y } } : {}),
    };
  });
  c.audio = (c.audio ?? []).map((s, i) => ({
    ...s,
    streamIndex: s.streamIndex ?? 1 + i,
    codec: s.codec ?? '',
    language: s.language ?? 'und',
  }));
  c.subtitles = (c.subtitles ?? []).map((s, i) => ({
    ...s,
    streamIndex: s.streamIndex ?? 10 + i,
    codec: s.codec ?? '',
    language: s.language ?? 'und',
    forced: s.forced ?? false,
    hearingImpaired: s.hearingImpaired ?? false,
    isImageBased: s.isImageBased ?? false,
  }));
  c.schemaVersion = 1;
  return c as VectorInput['info'];
}

export function wireScan(
  scan: SourceScan | null | undefined,
): VectorInput['scan'] {
  return scan
    ? { ...JSON.parse(JSON.stringify(scan)), schemaVersion: 1 }
    : null;
}
