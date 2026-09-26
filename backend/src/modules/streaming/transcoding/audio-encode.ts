import { SURROUND_TRANSCODE_BITRATE_BPS } from './profiles';

/** Audio codecs the backend encodes to. */
export type AudioEncodeCodec = 'aac' | 'ac3' | 'eac3' | 'opus';

/** Single-track audio output decision: a verbatim copy, or the encode target. */
export type AudioPlan =
  | { mode: 'copy'; codec: string }
  | {
      mode: 'transcode';
      codec: AudioEncodeCodec;
      bitrateBps: number;
      channels: number;
    };

/** One audio rendition's output decision, as ffmpeg consumes it. */
export interface AudioTrackEncodePlan {
  copy: boolean;
  outputCodec: string;
  outputChannels?: number;
}

const ENCODERS: Record<AudioEncodeCodec, string> = {
  aac: 'aac',
  ac3: 'ac3',
  eac3: 'eac3',
  opus: 'libopus',
};

/** Measured on jellyfin-ffmpeg 8.1: `ac3`/`eac3` reject 6.1 and 7.1, `aac` and
 *  `libopus` encode 7.1. */
const ENCODER_MAX_CHANNELS: Record<AudioEncodeCodec, number> = {
  aac: 8,
  opus: 8,
  ac3: 6,
  eac3: 6,
};

/** Samples per packet and priming ahead of the first, measured on jellyfin-ffmpeg
 *  8.1: a stream aligned at t starts at t - padding / rate. */
const ENCODER_FRAMES: Record<AudioEncodeCodec, { frame: number; padding: number }> = {
  aac: { frame: 1024, padding: 1024 },
  opus: { frame: 960, padding: 312 },
  ac3: { frame: 1536, padding: 256 },
  eac3: { frame: 1536, padding: 256 },
};

/** Sample rates each encoder takes; ffmpeg converts any other input to the
 *  first (checked from 22.05, 88.2 and 192 kHz). */
const ENCODER_RATES: Record<AudioEncodeCodec, number[]> = {
  aac: [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350],
  opus: [48000, 24000, 16000, 12000, 8000],
  ac3: [48000, 44100, 32000],
  eac3: [48000, 44100, 32000],
};

/** Packet grid (seconds) of an encoded track: its packets start at
 *  `alignedAt - padding + k · frame`. */
export interface PacketGrid {
  frame: number;
  padding: number;
}

/** The grid an encode of a track at `inputRate` lands on; null when unknown. */
export function encodedPacketGrid(
  codec: AudioEncodeCodec,
  inputRate: number | undefined,
): PacketGrid | null {
  if (!inputRate) return null;
  const rates = ENCODER_RATES[codec];
  const rate = rates.includes(inputRate) ? inputRate : rates[0];
  const { frame, padding } = ENCODER_FRAMES[codec];
  return { frame: frame / rate, padding: padding / rate };
}

export function isEncodableAudio(codec: string): codec is AudioEncodeCodec {
  return Object.prototype.hasOwnProperty.call(ENCODERS, codec);
}

export function audioEncoderName(codec: AudioEncodeCodec): string {
  return ENCODERS[codec];
}

export function encoderMaxChannels(codec: AudioEncodeCodec): number {
  return ENCODER_MAX_CHANNELS[codec];
}

/** A rung's audio bitrate is a stereo budget, so each further channel pair
 *  gets as much again. AC-3 / E-AC-3 always run at the surround ceiling. */
export function audioEncodeBitrateBps(
  codec: AudioEncodeCodec,
  channels: number,
  stereoBitrateBps: number,
): number {
  if (codec === 'ac3' || codec === 'eac3')
    return SURROUND_TRANSCODE_BITRATE_BPS;
  return Math.round((stereoBitrateBps * Math.max(channels, 2)) / 2);
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
    audioEncoderName(codec),
    `-b:a${spec}`,
    `${Math.round(bitrateBps / 1000)}k`,
    // `-ac` carries no stream type, so an indexed one must name the audio.
    spec ? `-ac:a${spec}` : '-ac',
    String(channels),
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

/** The per-rendition form of a single-track plan. */
export function trackEncodePlan(plan: AudioPlan): AudioTrackEncodePlan {
  return plan.mode === 'copy'
    ? { copy: true, outputCodec: plan.codec }
    : { copy: false, outputCodec: plan.codec, outputChannels: plan.channels };
}
