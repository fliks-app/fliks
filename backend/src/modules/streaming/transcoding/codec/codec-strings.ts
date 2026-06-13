import type { EncoderTarget } from './types';

/** RFC 6381 CODECS attribute generators. Each function returns the
 *  string that goes inside `CODECS="..."` on an `EXT-X-STREAM-INF`
 *  master-playlist entry.
 *
 *  Why per-rung strings: iOS AVPlayer (and Shaka in strict mode) filter
 *  variants whose declared profile doesn't match the bitstream SPS,
 *  and reinitialise the decoder mid-stream when the declared level is
 *  below what the SPS signals. Picking the level from `height × fps`
 *  guarantees the manifest claim covers the actual encoder output.
 */

/** H.264 — `avc1.PPCCLL` (6 hex digits). High profile = `64`, constraint
 *  set byte `00` (no flags), level encoded as hex.
 *
 *  Level matches what the encoder actually emits: H.264 encoders
 *  (h264_qsv, libx264, h264_vaapi, h264_nvenc, h264_videotoolbox) pick
 *  the lowest level whose `MaxMBPerSec` covers the rung's macroblock
 *  rate, and forcing a higher level via `-level:v` is fragile (qsv
 *  refuses, others happily ignore). A 1080p24 transcode runs at
 *  ~49 M luma samples/s — well within L4.0 (62 M) — so the encoder
 *  picks L4.0. An overpromise like `64002a` (L4.2) makes Cast Shaka
 *  reject the variant with 4032 CONTENT_UNSUPPORTED_BY_BROWSER because
 *  the bitstream level_idc (40) doesn't match the manifest claim (42).
 *  Drive the level off luma sample rate to keep manifest == bitstream. */
export function h264CodecString(target: EncoderTarget): string {
  // Pick the lowest level whose MaxFS (frame size in macroblocks) AND
  // MaxMBPerSec (macroblock rate) both cover this rung — mirrors what
  // every H.264 encoder we drive does internally. A pure luma-sample-rate
  // bucket would mis-classify 1080p24 (49 M samples/s, fits L3.2 by
  // rate) as L3.2 even though MaxFS=5120 MB rejects the 8160-MB frame.
  // The level_idc that ends up in the SPS would be L4.0; advertising
  // L3.2 in the manifest then trips Cast Shaka with 4032
  // CONTENT_UNSUPPORTED_BY_BROWSER.
  const mbPerFrame = Math.ceil(target.width / 16) * Math.ceil(target.height / 16);
  const mbPerSec = mbPerFrame * target.frameRate;
  // [hex level_idc, MaxFS, MaxMBPerSec]
  const levels: Array<[string, number, number]> = [
    ['0a', 99, 1485], //       L1.0
    ['0c', 396, 3000], //      L1.2
    ['0d', 396, 11880], //     L1.3
    ['15', 792, 19800], //     L2.1
    ['16', 1620, 20250], //    L2.2
    ['1e', 1620, 40500], //    L3.0
    ['1f', 3600, 108000], //   L3.1
    ['20', 5120, 216000], //   L3.2
    ['28', 8192, 245760], //   L4.0
    ['29', 8192, 245760], //   L4.1
    ['2a', 8704, 522240], //   L4.2
    ['32', 22080, 589824], //  L5.0
    ['33', 36864, 983040], //  L5.1
    ['34', 36864, 2073600], // L5.2
  ];
  for (const [lvl, maxFS, maxMBPS] of levels) {
    if (mbPerFrame <= maxFS && mbPerSec <= maxMBPS) {
      return `avc1.6400${lvl}`;
    }
  }
  return 'avc1.640034'; // Above L5.2 falls back to its codec string; the
  // encoder will refuse the stream anyway.
}

/** HEVC SDR Main 8-bit — `hvc1.1.6.L<level*30>.B0`. Profile = Main,
 *  profile-compat = `6`, tier = Main (`L`). */
export function hevcMainCodecString(target: EncoderTarget): string {
  return `hvc1.1.6.${hevcLevel(target)}.B0`;
}

/** HEVC HDR Main10 — `hvc1.2.4.L<level*30>.B0`. Profile space prefix
 *  `2` = profile_space + profile_idc combined (Main10), compat `4`. */
export function hevcMain10CodecString(target: EncoderTarget): string {
  return `hvc1.2.4.${hevcLevel(target)}.B0`;
}

/** AV1 — `av01.<profile>.<level><tier>.<bit_depth>` (simplified form;
 *  Apple/Android both accept this short form for HLS). Profile 0 = Main,
 *  tier `M` = Main, level = `level_idc * 30`. */
export function av1CodecString(
  target: EncoderTarget,
  bitDepth: 8 | 10,
): string {
  return `av01.0.${av1Level(target)}M.${String(bitDepth).padStart(2, '0')}`;
}

// ───────────────────────── helpers ─────────────────────────

/** HEVC level + its Main-tier bitrate ceiling, resolved from one luma-rate
 *  table so the declared CODECS level and the encode bitrate cap can never
 *  disagree. `idc = level * 30`; `mainTierMaxBitrateBps` is the HEVC Annex A
 *  `MaxBR` for the Main tier at that level (High tier allows ~4× more, but we
 *  declare and stay on Main — see {@link hevcMainTierCapBps}). */
interface HevcLevelInfo {
  idc: number;
  mainTierMaxBitrateBps: number;
}

function hevcLevelInfo(target: EncoderTarget): HevcLevelInfo {
  const lumaPerSec = target.width * target.height * target.frameRate;
  if (lumaPerSec <= 33_177_600) return { idc: 93, mainTierMaxBitrateBps: 10_000_000 }; //   L3.1
  if (lumaPerSec <= 66_846_720) return { idc: 120, mainTierMaxBitrateBps: 12_000_000 }; //  L4.0
  if (lumaPerSec <= 133_693_440) return { idc: 123, mainTierMaxBitrateBps: 20_000_000 }; // L4.1
  if (lumaPerSec <= 267_386_880) return { idc: 150, mainTierMaxBitrateBps: 25_000_000 }; // L5.0
  if (lumaPerSec <= 534_773_760) return { idc: 153, mainTierMaxBitrateBps: 40_000_000 }; // L5.1
  return { idc: 156, mainTierMaxBitrateBps: 60_000_000 }; //                                L5.2
}

/** HEVC level encoded as `L<level_idc>` where `level_idc = level * 30`.
 *  Picked to match the level the encoder will pick on its own — both
 *  HEVC Spec Annex A and every encoder we drive (hevc_qsv, hevc_vaapi,
 *  hevc_nvenc, hevc_videotoolbox, libx265) choose the lowest level
 *  whose `MaxLumaSr` covers the actual luma sample rate. Driving the
 *  master CODECS string from the same arithmetic keeps the declared
 *  level lock-stepped to the bitstream — forcing the level via
 *  `-level:v` blows up hevc_qsv on iHD ("some encoding parameters are
 *  not supported by the QSV runtime"), so we match what the encoder
 *  emits instead of telling it what to emit. */
function hevcLevel(target: EncoderTarget): string {
  return `L${hevcLevelInfo(target).idc}`;
}

/** Main-tier `MaxBR` (bits/s) for the level {@link hevcLevel} resolves to.
 *  The CODECS string always declares the Main tier (`hvc1.1.6.L*` /
 *  `hvc1.2.4.L*`), but HEVC encoders auto-flip `general_tier_flag` to High
 *  when the encode bitrate exceeds the Main-tier ceiling for the level — and a
 *  High-tier bitstream behind a Main-tier manifest claim is rejected by strict
 *  hardware MediaCodec decoders (Shaka 3014). Clamp the encode `-b:v`/`-maxrate`
 *  to this ceiling for HEVC rungs so the bitstream stays Main tier and matches
 *  the declared `L<level>`. */
export function hevcMainTierCapBps(target: EncoderTarget): number {
  return hevcLevelInfo(target).mainTierMaxBitrateBps;
}

/** AV1 level encoded as `<level_idc>` (decimal). Levels follow the AV1
 *  spec table A.3 (max display luma sample count per second). */
function av1Level(target: EncoderTarget): string {
  const { width, height, frameRate } = target;
  const lumaPerSec = width * height * frameRate;
  if (lumaPerSec > 1_069_547_520) return '13'; // L5.1 — 4K60
  if (lumaPerSec > 530_841_600) return '12'; //   L5.0 — 4K30
  if (lumaPerSec > 311_951_360) return '09'; //   L4.1 — 1080p60
  if (lumaPerSec > 155_975_680) return '08'; //   L4.0 — 1080p30
  if (lumaPerSec > 83_558_400) return '06'; //    L3.1 — 720p60
  return '04'; //                                 L3.0 — 720p30
}

/** Audio codecs we can emit an RFC 6381 CODECS string for: transcode targets
 *  AAC / AC-3 / E-AC-3, copy-mode additionally passes through Opus / FLAC. The
 *  `Record` below is keyed by this type, so adding a codec is a compile error
 *  until its CODECS string is supplied. */
export type AudioOutputCodec = 'aac' | 'ac3' | 'eac3' | 'opus' | 'flac';

const AUDIO_CODEC_STRINGS: Record<AudioOutputCodec, string> = {
  aac: 'mp4a.40.2',
  ac3: 'ac-3',
  eac3: 'ec-3',
  opus: 'Opus',
  flac: 'fLaC',
};

/**
 * RFC 6381 CODECS string for an output audio codec, or null when the codec is
 * outside {@link AudioOutputCodec}. Input is `string` — copy-mode passes the
 * raw source codec (see AudioPlan), which can be anything (e.g. truehd, dts).
 * An unrecognised codec must be omitted from CODECS rather than mislabeled as
 * AAC: a wrong codec hard-rejects on MSE append, a missing one is probed.
 */
export function audioCodecString(codec: string): string | null {
  return AUDIO_CODEC_STRINGS[codec.toLowerCase() as AudioOutputCodec] ?? null;
}

/**
 * CHANNELS value for an EXT-X-MEDIA audio rendition. AAC output is always
 * downmixed to stereo (`-ac 2`); copy / AC-3 / E-AC-3 keep the source layout
 * (no `-ac`), so they report the source channel count. Falls back to 2 when
 * the source count is unknown.
 */
export function audioRenditionChannels(
  outputAudioCodec: string,
  sourceChannels: number | undefined,
): number {
  if (outputAudioCodec.toLowerCase() === 'aac') return 2;
  return sourceChannels && sourceChannels > 0 ? sourceChannels : 2;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
