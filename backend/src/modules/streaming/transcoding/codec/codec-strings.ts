import type { EncoderTarget, HdrFormat } from './types';

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

/** Dolby Vision — `dvh1.PP.LL`. Apple HLS requires `dvh1` (parameter sets
 *  in moov), never `dvhe`. Profile and level pulled from the source's DV
 *  RPU sidedata when present. Listed for completeness — we don't transcode
 *  to DV, only pass through on DirectPlay. */
export function dolbyVisionCodecString(profile: number, level: number): string {
  return `dvh1.${pad2(profile)}.${pad2(level)}`;
}

/** Generates `SUPPLEMENTAL-CODECS` value for HDR10+/DV backward-compat
 *  variants. Apple HLS 2024+. */
export function supplementalCodecsBrand(hdr: HdrFormat): string | null {
  switch (hdr) {
    case 'HDR10':
      return null; // No supplemental codec for vanilla HDR10
    case 'HLG':
      return null;
    case 'DV5':
      return null; // Profile 5 has no HDR10/HLG fallback
    case 'DV81':
      return 'db1p'; // DV 8.1 → HDR10 BL
    case 'DV84':
      return 'db4h'; // DV 8.4 → HLG BL
  }
}

/** VIDEO-RANGE master-playlist attribute. iOS AVPlayer reads this to
 *  filter variants by display transfer-function compatibility. */
export function videoRange(hdr: HdrFormat | null): 'SDR' | 'PQ' | 'HLG' {
  if (hdr == null) return 'SDR';
  if (hdr === 'HLG') return 'HLG';
  return 'PQ'; // HDR10, DV5, DV81, DV84 all carry PQ-tagged transfer
}

// ───────────────────────── helpers ─────────────────────────

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
  const lumaPerSec = target.width * target.height * target.frameRate;
  if (lumaPerSec <= 33_177_600) return 'L93'; //   L3.1
  if (lumaPerSec <= 66_846_720) return 'L120'; //  L4.0
  if (lumaPerSec <= 133_693_440) return 'L123'; // L4.1
  if (lumaPerSec <= 267_386_880) return 'L150'; // L5.0
  if (lumaPerSec <= 534_773_760) return 'L153'; // L5.1
  return 'L156'; //                                L5.2
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

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
