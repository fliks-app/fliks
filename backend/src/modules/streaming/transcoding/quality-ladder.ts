import {
  cappedTranscodeVideoBitrateBps,
  parseBitrateToBps,
  profileResolution,
} from './profiles';
import { hevcMainTierCapBps } from './codec/codec-strings';
import type { TranscodeProfile } from './types';

export interface RungBitrateContext {
  /** Output codec the rung transcodes to ('hevc' / 'av1' / 'h264'); only HEVC
   *  is Main-tier-clamped. Undefined falls back to the H.264 baseline. */
  outputCodec: string | undefined;
  sourceWidth: number;
  sourceHeight: number;
  sourceFrameRate: number;
  /** Resolved source video bitrate (resolveSourceVideoBitrateBps), used to cap
   *  a forced transcode to the source so it never inflates a low-bitrate file. */
  sourceVideoBitrateBps: number | undefined;
  sourceVideoCodec: string | undefined;
}

/**
 * The video bitrate one ABR rung actually encodes at — the single source of
 * truth shared by the manifest BANDWIDTH, the playback-info per-quality hint and
 * the encoder `-b:v`, so they can't drift apart. The rung nominal, capped to the
 * (codec-efficiency-scaled) source bitrate, then — for HEVC — clamped to the
 * level's Main-tier ceiling so the bitstream stays Main tier and matches the
 * declared `L<level>` CODECS string (#474).
 */
export function cappedRungVideoBitrateBps(
  rung: TranscodeProfile,
  ctx: RungBitrateContext,
): number {
  let bps = cappedTranscodeVideoBitrateBps(
    parseBitrateToBps(rung.videoBitrate),
    ctx.sourceVideoBitrateBps,
    ctx.sourceVideoCodec,
    ctx.outputCodec,
  );
  if (ctx.outputCodec === 'hevc') {
    const { width, height } = profileResolution(
      rung,
      ctx.sourceWidth,
      ctx.sourceHeight,
    );
    bps = Math.min(
      bps,
      hevcMainTierCapBps({
        width,
        height,
        videoBitrateBps: 0,
        gopSize: 0,
        frameRate: ctx.sourceFrameRate,
      }),
    );
  }
  return bps;
}
