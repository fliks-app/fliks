import { isLibfdkAacEnabled } from './audio-encoder-probe';

/** Audio codecs the backend encodes to. */
export type AudioEncodeCodec = 'aac' | 'ac3' | 'eac3' | 'opus';

/** Encoder binaries `aac` can resolve to, so the tables below stay the one
 *  source of truth for both a codec's ceiling and a binary's own limit. */
type AudioEncoderId = AudioEncodeCodec | 'libfdk_aac';

/** One audio output's decision, per rendition or for the one muxed track: a
 *  verbatim copy of the source, with its probed bitrate and ffprobe profile, or
 *  the encode target. */
export type AudioPlan =
  | {
      mode: 'copy';
      codec: string;
      channels?: number;
      bitrateBps?: number;
      profile?: string;
    }
  | { mode: 'transcode'; codec: AudioEncodeCodec; channels: number };

/** The output of a session that carries no decision: AAC stereo plays everywhere. */
export const DEFAULT_AUDIO_PLAN: AudioPlan = {
  mode: 'transcode',
  codec: 'aac',
  channels: 2,
};

const ENCODERS: Record<AudioEncodeCodec, string> = {
  aac: 'aac',
  ac3: 'ac3',
  eac3: 'eac3',
  opus: 'libopus',
};

/** Measured on jellyfin-ffmpeg 8.1: `ac3`/`eac3` reject 6.1 and 7.1, `aac` and
 *  `libopus` encode 7.1. `libfdk_aac` caps at 5.1 (Fraunhofer library limit),
 *  so 7.1/8-channel AAC output stays on the native encoder. */
const ENCODER_MAX_CHANNELS: Record<AudioEncoderId, number> = {
  aac: 8,
  libfdk_aac: 6,
  opus: 8,
  ac3: 6,
  eac3: 6,
};

/** Samples per packet and priming ahead of the first, measured on jellyfin-ffmpeg
 *  8.1 (init segment edit-list `media_time`): a stream aligned at t starts at
 *  t - padding / rate. `libfdk_aac` primes a full extra frame over native `aac`
 *  (2048 vs 1024 samples), same 1024-sample AAC-LC frame either way. */
const ENCODER_FRAMES: Record<AudioEncoderId, { frame: number; padding: number }> = {
  aac: { frame: 1024, padding: 1024 },
  libfdk_aac: { frame: 1024, padding: 2048 },
  opus: { frame: 960, padding: 312 },
  ac3: { frame: 1536, padding: 256 },
  eac3: { frame: 1536, padding: 256 },
};

/** Which binary an `'aac'` encode runs on: libfdk when the boot probe found it
 *  and the output fits its 6-channel ceiling, else the native fallback. */
function resolvedAacEncoder(channels: number): 'aac' | 'libfdk_aac' {
  return isLibfdkAacEnabled() && channels <= ENCODER_MAX_CHANNELS.libfdk_aac
    ? 'libfdk_aac'
    : 'aac';
}

/** Every encode runs at 48 kHz: what Opus and Dolby take, and one of the two
 *  rates Apple's HLS authoring spec allows for AAC, which would otherwise keep
 *  a 96 kHz source's rate. */
export const ENCODE_SAMPLE_RATE = 48_000;

/** Packet grid (seconds) of an encoded track: its packets start at
 *  `alignedAt - padding + k · frame`. */
export interface PacketGrid {
  frame: number;
  padding: number;
}

/** The grid an encode of `channels` to `codec` lands on: resolves to the same
 *  binary {@link audioEncoderName} would pick, since `aac` priming differs by
 *  encoder. */
export function encodedPacketGrid(
  codec: AudioEncodeCodec,
  channels: number,
): PacketGrid {
  const key = codec === 'aac' ? resolvedAacEncoder(channels) : codec;
  const { frame, padding } = ENCODER_FRAMES[key];
  return {
    frame: frame / ENCODE_SAMPLE_RATE,
    padding: padding / ENCODE_SAMPLE_RATE,
  };
}

/** The AC-3 encoder's highest bitrate, and the most a Dolby encode spends. */
const DOLBY_MAX_BITRATE_BPS = 640_000;

/** The rates an AC-3 bitstream can carry; ffmpeg rounds any other to one. */
const AC3_BITRATES_BPS = [
  32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512,
  576, 640,
].map((k) => k * 1000);

/** The least a Dolby encode of `channels` spends: Dolby's AC-3 rates, 192 kbps
 *  for stereo and 384 kbps for 5.1, or 48 kbps a channel on top of stereo;
 *  E-AC-3 matches AC-3 at two thirds of its rate. */
function dolbyFloorBps(codec: 'ac3' | 'eac3', channels: number): number {
  const ac3 = 192_000 + 48_000 * (Math.max(channels, 2) - 2);
  return codec === 'ac3' ? ac3 : Math.round((ac3 * 2) / 3);
}

export function isEncodableAudio(codec: string): codec is AudioEncodeCodec {
  return Object.prototype.hasOwnProperty.call(ENCODERS, codec);
}

/** Encoder binary for one output stream: `aac` resolves to `libfdk_aac` when
 *  the boot probe found it and `channels` fits its limit, else native `aac`. */
export function audioEncoderName(
  codec: AudioEncodeCodec,
  channels: number,
): string {
  return codec === 'aac' ? resolvedAacEncoder(channels) : ENCODERS[codec];
}

export function encoderMaxChannels(codec: AudioEncodeCodec): number {
  return ENCODER_MAX_CHANNELS[codec];
}

/** A rung's audio bitrate is a stereo budget, so each further channel pair
 *  gets as much again. A Dolby encode stays within Dolby's recommended range
 *  for its layout, on a rate AC-3 can carry. */
export function audioEncodeBitrateBps(
  codec: AudioEncodeCodec,
  channels: number,
  stereoBitrateBps: number,
): number {
  const budget = Math.round((stereoBitrateBps * Math.max(channels, 2)) / 2);
  if (codec !== 'ac3' && codec !== 'eac3') return budget;
  const bps = Math.min(
    DOLBY_MAX_BITRATE_BPS,
    Math.max(dolbyFloorBps(codec, channels), budget),
  );
  return codec === 'ac3' ? AC3_BITRATES_BPS.find((r) => r >= bps)! : bps;
}

/** Bitrate an audio output streams at on a rung of `stereoBitrateBps`: an
 *  encode's target, a copy's source bitrate, or for a copy of unknown bitrate
 *  what an encode of that layout would spend. */
export function audioOutputBitrateBps(
  plan: AudioPlan,
  stereoBitrateBps: number,
): number {
  if (plan.mode === 'copy' && plan.bitrateBps) return plan.bitrateBps;
  return audioEncodeBitrateBps(
    isEncodableAudio(plan.codec) ? plan.codec : 'aac',
    plan.channels ?? 2,
    stereoBitrateBps,
  );
}

/** Encode args for one audio output stream (`spec` `''` or `:<i>`). */
export function audioEncodeArgs(
  spec: string,
  codec: AudioEncodeCodec,
  channels: number,
  bitrateBps: number,
): string[] {
  return [
    `-c:a${spec}`,
    audioEncoderName(codec, channels),
    `-b:a${spec}`,
    `${Math.round(bitrateBps / 1000)}k`,
    // `-ac` / `-ar` carry no stream type, so an indexed one must name the audio.
    spec ? `-ac:a${spec}` : '-ac',
    String(channels),
    spec ? `-ar:a${spec}` : '-ar',
    String(ENCODE_SAMPLE_RATE),
  ];
}

/** Copy args for one audio output stream (`spec` `''` or `:<i>`). MP4 carries
 *  AAC raw while MPEG-TS carries it as ADTS; raw AAC passes the filter as is. */
export function audioCopyArgs(
  spec: string,
  codec: string,
  useTs: boolean,
): string[] {
  const bsf =
    codec === 'aac' && !useTs ? [`-bsf:a${spec}`, 'aac_adtstoasc'] : [];
  return [`-c:a${spec}`, 'copy', ...bsf];
}
