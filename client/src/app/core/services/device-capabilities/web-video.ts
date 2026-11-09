import type { CodecCondition } from '../browser-device-profile.service';

/** Whether the engine decodes a MIME type: MSE's `isTypeSupported` (HLS plays through MSE), else `canPlayType`. */
export type TypeProbe = (mime: string) => boolean;

export interface WebVideo {
  containers: string[];
  videoCodecs: string[];
  codecConditions: CodecCondition[];
}

const mp4 = (codec: string) => `video/mp4; codecs="${codec}"`;
const webm = (codec: string) => `video/webm; codecs="${codec}"`;

/** Highest first-failing-stops probe: level number to the codec string that carries it. */
const H264_LEVELS: ReadonlyArray<[number, string]> = [
  [30, 'avc1.42001E'], [31, 'avc1.42001F'], [40, 'avc1.640028'], [41, 'avc1.640029'], [42, 'avc1.64002A'],
  [50, 'avc1.640032'], [51, 'avc1.640033'], [52, 'avc1.640034'], [60, 'avc1.64003C'], [62, 'avc1.64003E'],
];
const HEVC_LEVELS: ReadonlyArray<[number, string]> = [
  [120, 'hvc1.1.6.L120.B0'], [123, 'hvc1.1.6.L123.B0'], [150, 'hvc1.1.6.L150.B0'], [153, 'hvc1.1.6.L153.B0'],
  [156, 'hvc1.1.6.L156.B0'], [180, 'hvc1.1.6.L180.B0'], [186, 'hvc1.1.6.L186.B0'],
];

function maxLevel(levels: ReadonlyArray<[number, string]>, supported: TypeProbe): number {
  let max = levels[0][0];
  for (const [level, codec] of levels) {
    if (!supported(mp4(codec))) break;
    max = level;
  }
  return max;
}

/** Containers, codecs and per-codec limits the engine's own probe reports. MKV is never listed: no engine demuxes it, so a supported codec inside still remuxes to HLS. */
export function detectWebVideo(supported: TypeProbe): WebVideo {
  const containers: string[] = [];
  const videoCodecs: string[] = [];
  const codecConditions: CodecCondition[] = [];

  if (supported(mp4('avc1.42E01E'))) containers.push('mp4', 'm4v', 'mov');
  if (supported(webm('vp8'))) containers.push('webm');

  if (supported(mp4('avc1.42E01E'))) {
    videoCodecs.push('h264', 'avc1');
    codecConditions.push({
      codec: 'h264',
      maxLevel: maxLevel(H264_LEVELS, supported),
      profiles: ['baseline', 'constrained baseline', 'main', 'high'],
      maxBitDepth: 8,
    });
  }
  if (supported(mp4('hvc1.1.6.L120.B0')) || supported(mp4('hev1.1.6.L120.B0'))) {
    videoCodecs.push('hevc', 'h265', 'hvc1');
    const maxBitDepth = supported(mp4('hvc1.2.4.L120.B0')) ? 10 : 8;
    codecConditions.push({
      codec: 'hevc',
      maxLevel: maxLevel(HEVC_LEVELS, supported),
      profiles: maxBitDepth >= 10 ? ['main', 'main 10'] : ['main'],
      maxBitDepth,
    });
  }
  if (supported(mp4('av01.0.08M.08'))) {
    videoCodecs.push('av1');
    const maxBitDepth = supported(mp4('av01.0.08M.10')) ? 10 : 8;
    codecConditions.push({
      codec: 'av1',
      maxBitDepth,
      profiles: maxBitDepth >= 10 ? ['main', 'high'] : ['main'],
    });
  }
  if (supported(webm('vp09.00.10.08')) || supported(webm('vp9'))) videoCodecs.push('vp9');
  if (supported(webm('vp8'))) videoCodecs.push('vp8');
  return { containers, videoCodecs, codecConditions };
}

/** Single-layer Dolby Vision profiles the engine claims; P10 is the AV1 flavour. */
export function detectDolbyVisionProfiles(supported: TypeProbe): number[] {
  const profiles: number[] = [];
  if (supported(mp4('dvh1.05.06')) || supported(mp4('dvhe.05.06'))) profiles.push(5);
  if (supported(mp4('dvh1.08.06')) || supported(mp4('dvhe.08.06'))) profiles.push(8);
  if (supported(mp4('dav1.10.06'))) profiles.push(10);
  return profiles;
}

/** Sample entries a raw MP4 may carry beyond its codec's own (`avc1`, `hvc1`, `av01`), and the codec strings probing them. */
const EXTRA_SAMPLE_ENTRIES: ReadonlyArray<[codec: string, entry: string, probes: string[]]> = [
  ['h264', 'avc3', ['avc3.640028']],
  ['hevc', 'hev1', ['hev1.1.6.L120.B0']],
  ['hevc', 'dvh1', ['dvh1.05.06', 'dvh1.08.06']],
  ['hevc', 'dvhe', ['dvhe.05.06', 'dvhe.08.06']],
  ['av1', 'dav1', ['dav1.10.06']],
];

/** The sample entries the file's own demuxer reads, asked with `canPlayType` (MSE refuses `hev1` on Apple). A native demuxer with no usable probe takes them all. */
export function detectSampleEntries(codecs: readonly string[], plays: TypeProbe, takesAll: boolean): string[] {
  return EXTRA_SAMPLE_ENTRIES.filter(
    ([codec, , probes]) => codecs.includes(codec) && (takesAll || probes.some((c) => plays(mp4(c)))),
  ).map(([, entry]) => entry);
}

/** Every MIME `detectWebVideo` and `detectDolbyVisionProfiles` may ask, for one batch of `mediaCapabilities` queries. */
export function webVideoMimes(): string[] {
  const asked = new Set<string>();
  const record: TypeProbe = (m) => (asked.add(m), true);
  detectWebVideo(record);
  detectDolbyVisionProfiles(record);
  return [...asked];
}
