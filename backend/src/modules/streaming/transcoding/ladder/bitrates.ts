import type { CodecVariant, BitDepth } from '../codec/types';
import type { DeviceType } from '../types';

/** Bitrate ladder anchored on H.264 SDR. Each rung lists `(maxHeight,
 *  videoKbps, audioKbps)` for the standard H.264 target. Other codecs
 *  scale this ladder by the ratios in {@link CODEC_BITRATE_RATIO} —
 *  HEVC is ~30% more efficient than H.264 at equivalent visual quality,
 *  AV1 ~50%. Mobile uses lower bitrates because cellular bandwidth and
 *  battery decode budget are both tighter. */
interface RungSpec {
  maxHeight: number;
  width: number;
  videoKbps: number;
  audioKbps: number;
}

const DESKTOP_BASE: readonly RungSpec[] = [
  { maxHeight: 2160, width: 3840, videoKbps: 20000, audioKbps: 192 },
  { maxHeight: 1080, width: 1920, videoKbps: 8000, audioKbps: 192 },
  { maxHeight: 720, width: 1280, videoKbps: 4000, audioKbps: 128 },
  { maxHeight: 480, width: 854, videoKbps: 2000, audioKbps: 96 },
  { maxHeight: 360, width: 640, videoKbps: 1000, audioKbps: 64 },
  { maxHeight: 240, width: 426, videoKbps: 500, audioKbps: 64 },
  { maxHeight: 144, width: 256, videoKbps: 200, audioKbps: 48 },
];

const MOBILE_BASE: readonly RungSpec[] = [
  { maxHeight: 2160, width: 3840, videoKbps: 8000, audioKbps: 192 },
  { maxHeight: 1080, width: 1920, videoKbps: 3000, audioKbps: 192 },
  { maxHeight: 720, width: 1280, videoKbps: 1500, audioKbps: 128 },
  { maxHeight: 480, width: 854, videoKbps: 800, audioKbps: 96 },
  { maxHeight: 360, width: 640, videoKbps: 500, audioKbps: 64 },
  { maxHeight: 240, width: 426, videoKbps: 300, audioKbps: 64 },
  { maxHeight: 144, width: 256, videoKbps: 150, audioKbps: 48 },
];

/** Codec efficiency ratio vs H.264. A 0.7 ratio means the codec needs
 *  70% of the H.264 bitrate to reach equivalent visual quality. The
 *  10-bit boost (+10%) compensates for the extra precision needed when
 *  encoding HDR or 10-bit SDR sources. */
const CODEC_BITRATE_RATIO: Record<CodecVariant['codec'], number> = {
  h264: 1.0,
  hevc: 0.7,
  av1: 0.5,
};

const BIT_DEPTH_BOOST: Record<BitDepth, number> = {
  8: 1.0,
  10: 1.1,
};

/** Resolved rung bitrate for a `(deviceType, variant, height)` triple. */
export function bitrateForRung(
  deviceType: DeviceType,
  variant: CodecVariant,
  height: number,
): { videoBps: number; audioBps: number; width: number } {
  const base = (deviceType === 'mobile' ? MOBILE_BASE : DESKTOP_BASE).find(
    (r) => r.maxHeight === height,
  );
  if (!base) {
    throw new Error(`No bitrate spec for height ${height}`);
  }
  const ratio =
    CODEC_BITRATE_RATIO[variant.codec] * BIT_DEPTH_BOOST[variant.bitDepth];
  return {
    videoBps: Math.round(base.videoKbps * 1000 * ratio),
    audioBps: base.audioKbps * 1000,
    width: base.width,
  };
}

/** Every rung height available for a given device type. */
export function rungHeights(deviceType: DeviceType): readonly number[] {
  const base = deviceType === 'mobile' ? MOBILE_BASE : DESKTOP_BASE;
  return base.map((r) => r.maxHeight);
}

/** Rungs that fit at or below `sourceHeight`. Used to avoid upscaling. */
export function availableHeights(
  deviceType: DeviceType,
  sourceHeight: number,
): number[] {
  return rungHeights(deviceType).filter((h) => h <= sourceHeight);
}
