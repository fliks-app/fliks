import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { inferLanguageCodeFromTitle } from '../../common/release-parsing/language.parser';
import { isImageBasedSubtitleCodec } from '../../common/constants/subtitle-codecs';

const execFileAsync = promisify(execFile);

export interface EmbeddedSubtitleStream {
  streamIndex: number;
  codec: string;
  language: string;
  forced: boolean;
  hearingImpaired: boolean;
  /** True for bitmap subtitles (PGS, VOBSUB, DVB) that need burn-in. */
  isImageBased: boolean;
}

export interface MediaStream {
  streamIndex: number;
  type: 'audio' | 'subtitle';
  codec: string;
  language: string;
  title?: string;
}

export type HdrFormat = 'HDR10' | 'HLG';

export interface CropInfo {
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface VideoStreamInfo {
  streamIndex: number;
  codec: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  displayAspectRatio?: string;
  pixelFormat?: string;
  frameRate?: string;
  /** Container start PTS of the video stream (seconds). Non-zero on TS / PVR
   *  rips; the `-copyts` transcode keeps the first frame at this time, so
   *  0-based sidecar/embedded subtitle cues must be shifted by it. */
  startTimeSeconds?: number;
  bitRate?: number;
  bitDepth?: number;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  colorRange?: string;
  hdrFormat?: HdrFormat;
  /** Dolby Vision profile from the stream's DOVI configuration record (e.g. 5,
   *  8), with its base-layer signal compatibility id (e.g. 8.1, 8.4), level, and
   *  which layers the record declares. `dvElPresent` tells single-layer (P5/P8)
   *  from dual-layer P7, whose enhancement layer is unreachable over HLS. */
  dvProfile?: number;
  dvBlSignalCompatId?: number;
  dvLevel?: number;
  dvRpuPresent?: boolean;
  dvBlPresent?: boolean;
  dvElPresent?: boolean;
  /** Source HDR10 static metadata (SMPTE ST 2086 mastering display + CTA-861.3
   *  content light), probed via frame side-data for HDR10 sources. Drives the
   *  encoder's master-display / max-cll so the display tonemaps to the source's
   *  real peak luminance instead of a generic 1000-nit reference. */
  hdrMetadata?: { masteringDisplay: string; maxCll: number; maxFall: number };
  crop?: CropInfo;
}

export interface AudioStreamInfo {
  streamIndex: number;
  codec: string;
  language: string;
  title?: string;
  channels?: number;
  channelLayout?: string;
  sampleRate?: number;
  bitRate?: number;
  isDefault?: boolean;
}

export interface SubtitleStreamInfo {
  streamIndex: number;
  codec: string;
  language: string;
  title?: string;
  forced: boolean;
  hearingImpaired: boolean;
  /** True for bitmap subtitles (PGS, VOBSUB, DVB) that need burn-in */
  isImageBased: boolean;
}

export interface Chapter {
  startSeconds: number;
  endSeconds: number;
  title?: string;
}

export interface MediaFileInfo {
  video: VideoStreamInfo[];
  audio: AudioStreamInfo[];
  subtitles: SubtitleStreamInfo[];
  /** Overall container bitrate from ffprobe `format.bit_rate` (bits/s). */
  formatBitRate?: number;
  durationSeconds?: number;
  /** Embedded chapter markers from the container (MKV/MP4). Empty if none. */
  chapters?: Chapter[];
  error?: string;
}

interface FfprobeStream {
  index: number;
  codec_name?: string;
  codec_type?: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  display_aspect_ratio?: string;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  start_time?: string;
  bit_rate?: string;
  bits_per_raw_sample?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_range?: string;
  side_data_list?: {
    side_data_type?: string;
    dv_profile?: number;
    dv_level?: number;
    dv_bl_signal_compatibility_id?: number;
    rpu_present_flag?: number;
    bl_present_flag?: number;
    el_present_flag?: number;
  }[];
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  tags?: Record<string, string | undefined>;
  disposition?: {
    forced?: number;
    hearing_impaired?: number;
    default?: number;
  };
}

/** Case-insensitive ffprobe tag lookup. Matroska stores per-stream
 *  metadata in its container-level Tags element with UPPERCASE keys
 *  (`LANGUAGE`, `TITLE` — common when a file has been touched by
 *  `mkvpropedit`), while the track-header path surfaces as lowercase
 *  (`language`, `title`). ffprobe passes both through verbatim, so a
 *  lowercase-only read silently misses the uppercase variant and the
 *  track falls back to `und`. */
function tag(
  tags: Record<string, string | undefined> | undefined,
  key: string,
): string | undefined {
  if (!tags) return undefined;
  const want = key.toLowerCase();
  for (const k of Object.keys(tags)) {
    if (k.toLowerCase() === want) return tags[k];
  }
  return undefined;
}

/** Resolve the language code of an ffprobe stream. The `language` tag is
 *  the authoritative source when set to anything other than `und`;
 *  otherwise fall back to inferring from the `title` tag (Emby / Plex
 *  muxers commonly carry the language name in the title, e.g.
 *  `"French AC3 5.1"`). Stays on `und` when neither is conclusive —
 *  auto-pick logic downstream handles the unknown-language case by
 *  ordering / size heuristics. Both tags are read case-insensitively
 *  (see {@link tag}). */
function resolveStreamLanguage(s: {
  tags?: Record<string, string | undefined>;
}): string {
  const explicit = tag(s.tags, 'language');
  if (explicit && explicit.toLowerCase() !== 'und') return explicit;
  return inferLanguageCodeFromTitle(tag(s.tags, 'title')) ?? 'und';
}

export interface HdrStaticMetadataDto {
  masteringDisplay: string;
  maxCll: number;
  maxFall: number;
}

/** Scale an ffprobe metadata value to its integer SEI unit. ffprobe emits
 *  rationals (`"13250/50000"`) on modern builds and bare decimals on older
 *  ones; both resolve to the same scaled integer. Returns null when unparseable
 *  so the caller can drop incomplete metadata rather than emit garbage. */
function scaleMetaValue(
  raw: string | number | undefined,
  unit: number,
): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Math.round(raw * unit);
  const [n, d] = raw.split('/');
  const num = Number(n);
  const den = d != null ? Number(d) : 1;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return Math.round((num / den) * unit);
}

/**
 * Parse ffprobe frame `side_data_list` into HDR10 static metadata. Builds the
 * `G()B()R()WP()L()` mastering-display string (coordinates in 0.00002 units,
 * luminance in 0.0001 cd/m²) plus MaxCLL/MaxFALL. Returns null when no
 * mastering-display side-data is present (HLG, SDR, or HDR10 without metadata)
 * or when it is incomplete.
 */
export function parseHdrStaticMetadata(
  sideDataList: unknown[] | undefined,
): HdrStaticMetadataDto | null {
  if (!Array.isArray(sideDataList)) return null;
  const typeOf = (d: unknown): string =>
    String((d as { side_data_type?: unknown })?.side_data_type ?? '');
  const md = sideDataList.find((d) => /mastering display/i.test(typeOf(d))) as
    | Record<string, string | number>
    | undefined;
  if (!md) return null;
  const cl = sideDataList.find((d) => /content light/i.test(typeOf(d))) as
    | Record<string, string | number>
    | undefined;

  const gx = scaleMetaValue(md.green_x, 50000);
  const gy = scaleMetaValue(md.green_y, 50000);
  const bx = scaleMetaValue(md.blue_x, 50000);
  const by = scaleMetaValue(md.blue_y, 50000);
  const rx = scaleMetaValue(md.red_x, 50000);
  const ry = scaleMetaValue(md.red_y, 50000);
  const wx = scaleMetaValue(md.white_point_x, 50000);
  const wy = scaleMetaValue(md.white_point_y, 50000);
  const maxL = scaleMetaValue(md.max_luminance, 10000);
  const minL = scaleMetaValue(md.min_luminance, 10000);
  if ([gx, gy, bx, by, rx, ry, wx, wy, maxL, minL].some((v) => v == null)) {
    return null;
  }

  const masteringDisplay = `G(${gx},${gy})B(${bx},${by})R(${rx},${ry})WP(${wx},${wy})L(${maxL},${minL})`;
  const maxCll = cl?.max_content != null ? Number(cl.max_content) : 0;
  const maxFall = cl?.max_average != null ? Number(cl.max_average) : 0;
  return {
    masteringDisplay,
    maxCll: Number.isFinite(maxCll) ? maxCll : 0,
    maxFall: Number.isFinite(maxFall) ? maxFall : 0,
  };
}

@Injectable()
export class FfprobeService {
  private readonly logger = new Logger(FfprobeService.name);

  async detectEmbeddedSubtitles(
    videoPath: string,
  ): Promise<EmbeddedSubtitleStream[]> {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'quiet',
          '-print_format',
          'json',
          '-show_streams',
          '-select_streams',
          's',
          videoPath,
        ],
        { timeout: 30_000 },
      );

      const parsed = JSON.parse(stdout) as { streams?: FfprobeStream[] };
      const streams = parsed.streams ?? [];

      return streams.map((s) => ({
        streamIndex: s.index,
        codec: s.codec_name ?? 'unknown',
        language: resolveStreamLanguage(s),
        forced: s.disposition?.forced === 1,
        hearingImpaired: s.disposition?.hearing_impaired === 1,
        isImageBased: isImageBasedSubtitleCodec(s.codec_name),
      }));
    } catch (err) {
      this.logger.warn(
        `ffprobe failed for "${videoPath}": ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Detect all audio and subtitle streams from a video file.
   * Used by the sync modal to let the user pick a reference track.
   */
  async detectStreams(videoPath: string): Promise<MediaStream[]> {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        ['-v', 'error', '-print_format', 'json', '-show_streams', videoPath],
        { timeout: 30_000 },
      );

      const parsed = JSON.parse(stdout) as { streams?: FfprobeStream[] };
      return (parsed.streams ?? [])
        .filter((s) => s.codec_type === 'audio' || s.codec_type === 'subtitle')
        .map((s) => ({
          streamIndex: s.index,
          type: s.codec_type as 'audio' | 'subtitle',
          codec: s.codec_name ?? 'unknown',
          language: resolveStreamLanguage(s),
          title: tag(s.tags, 'title'),
        }));
    } catch (err: unknown) {
      const e = err as { message?: string; stderr?: string };
      this.logger.warn(
        `ffprobe streams detection failed for "${videoPath}": ${e.message ?? String(err)}${e.stderr ? `\n  stderr: ${e.stderr}` : ''}`,
      );
      return [];
    }
  }

  async detectMediaFileInfo(videoPath: string): Promise<MediaFileInfo> {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_streams',
          '-show_format',
          '-show_chapters',
          videoPath,
        ],
        { timeout: 30_000 },
      );

      const parsed = JSON.parse(stdout) as {
        streams?: FfprobeStream[];
        format?: { duration?: string; bit_rate?: string };
        chapters?: {
          start_time?: string;
          end_time?: string;
          tags?: Record<string, string | undefined>;
        }[];
      };
      const streams = parsed.streams ?? [];
      const durationSeconds = parsed.format?.duration
        ? Number(parsed.format.duration)
        : undefined;
      const formatBitRateRaw = parsed.format?.bit_rate
        ? Number(parsed.format.bit_rate)
        : undefined;
      const formatBitRate =
        formatBitRateRaw && formatBitRateRaw > 0 ? formatBitRateRaw : undefined;

      const video: VideoStreamInfo[] = streams
        .filter((s) => s.codec_type === 'video')
        .map((s) => {
          const dovi = (s.side_data_list ?? []).find(
            (d) => typeof d.dv_profile === 'number',
          );
          return {
            streamIndex: s.index,
            codec: s.codec_name ?? 'unknown',
            profile: s.profile,
            level: s.level,
            width: s.width,
            height: s.height,
            displayAspectRatio: s.display_aspect_ratio,
            pixelFormat: s.pix_fmt,
            frameRate: this.parseFrameRate(s.r_frame_rate, s.avg_frame_rate),
            startTimeSeconds: s.start_time ? Number(s.start_time) : undefined,
            bitRate: s.bit_rate ? Number(s.bit_rate) : undefined,
            bitDepth: s.bits_per_raw_sample
              ? Number(s.bits_per_raw_sample)
              : undefined,
            colorSpace: s.color_space,
            colorTransfer: s.color_transfer,
            colorPrimaries: s.color_primaries,
            colorRange: s.color_range,
            hdrFormat: this.deriveHdrFormat(s.color_transfer, s.color_primaries),
            dvProfile: dovi?.dv_profile,
            dvBlSignalCompatId: dovi?.dv_bl_signal_compatibility_id,
            dvLevel: dovi?.dv_level,
            dvRpuPresent: dovi?.rpu_present_flag === 1,
            dvBlPresent: dovi?.bl_present_flag === 1,
            dvElPresent: dovi?.el_present_flag === 1,
          };
        });

      // HDR10 sources: probe the first frame's side-data for mastering-display
      // + content-light so the encoder signals the source's real peak luminance
      // instead of a generic 1000-nit reference. Gated to HDR10 (one extra
      // frame-decoding ffprobe pass); SDR / HLG imports skip it.
      if (video[0]?.hdrFormat === 'HDR10') {
        const meta = await this.probeHdrStaticMetadata(videoPath);
        if (meta) video[0].hdrMetadata = meta;
      }

      const audio: AudioStreamInfo[] = streams
        .filter((s) => s.codec_type === 'audio')
        .map((s) => ({
          streamIndex: s.index,
          codec: s.codec_name ?? 'unknown',
          language: resolveStreamLanguage(s),
          title: tag(s.tags, 'title'),
          channels: s.channels,
          channelLayout: s.channel_layout,
          sampleRate: s.sample_rate ? Number(s.sample_rate) : undefined,
          bitRate: s.bit_rate ? Number(s.bit_rate) : undefined,
          isDefault: s.disposition?.default === 1,
        }));

      const subtitles: SubtitleStreamInfo[] = streams
        .filter((s) => s.codec_type === 'subtitle')
        .map((s) => ({
          streamIndex: s.index,
          codec: s.codec_name ?? 'unknown',
          language: resolveStreamLanguage(s),
          title: tag(s.tags, 'title'),
          forced: s.disposition?.forced === 1,
          hearingImpaired: s.disposition?.hearing_impaired === 1,
          isImageBased: isImageBasedSubtitleCodec(s.codec_name),
        }));

      const chapters: Chapter[] = (parsed.chapters ?? [])
        .map((c) => ({
          startSeconds: c.start_time ? Number(c.start_time) : 0,
          endSeconds: c.end_time ? Number(c.end_time) : 0,
          title: tag(c.tags, 'title'),
        }))
        .filter((c) => c.endSeconds > c.startSeconds);

      if (!video.length && !audio.length) {
        return {
          video: [],
          audio: [],
          subtitles: [],
          formatBitRate,
          durationSeconds,
          chapters,
          error: 'No streams detected',
        };
      }
      return {
        video,
        audio,
        subtitles,
        formatBitRate,
        durationSeconds,
        chapters,
      };
    } catch (err: unknown) {
      const e = err as { message?: string; stderr?: string };
      const message =
        (typeof e.stderr === 'string' && e.stderr.trim()) ||
        e.message ||
        String(err);
      this.logger.warn(
        `ffprobe file info failed for "${videoPath}": ${message}`,
      );
      return { video: [], audio: [], subtitles: [], error: message };
    }
  }

  private deriveHdrFormat(
    colorTransfer?: string,
    colorPrimaries?: string,
  ): HdrFormat | undefined {
    // HDR is defined by the transfer curve, not the bit depth. An 8-bit PQ
    // file is mis-encoded but still needs the HDR pipeline (or tone-mapping):
    // played as SDR, the PQ values render as gamma 2.2 and the picture goes
    // dark/washed. Classify by transfer function alone.
    if (!colorTransfer) return undefined;
    const isBt2020 = colorPrimaries === 'bt2020';
    if (colorTransfer === 'smpte2084' && isBt2020) return 'HDR10';
    if (colorTransfer === 'arib-std-b67' && isBt2020) return 'HLG';
    return undefined;
  }

  /** Probe the first video frame's side-data for HDR10 static metadata
   *  (mastering display + content light). Gated to HDR10 sources by the caller
   *  so non-HDR imports skip the extra (frame-decoding) ffprobe pass. Returns
   *  null when the source carries no such metadata. */
  private async probeHdrStaticMetadata(
    videoPath: string,
  ): Promise<HdrStaticMetadataDto | null> {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-select_streams',
          'v:0',
          '-read_intervals',
          '%+#1',
          '-show_frames',
          '-show_entries',
          'frame=side_data_list',
          videoPath,
        ],
        { timeout: 15_000 },
      );
      const frames = (JSON.parse(stdout) as { frames?: { side_data_list?: unknown[] }[] }).frames;
      return parseHdrStaticMetadata(frames?.[0]?.side_data_list);
    } catch (err) {
      this.logger.warn(
        `HDR static-metadata probe failed for "${videoPath}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Normalise a ffprobe frame-rate to a decimal fps string (e.g. `23.976`).
   * Prefers `r_frame_rate` and falls back to `avg_frame_rate` when the former
   * is unusable (`0/0`, which VFR/some remuxed sources report): the transcode
   * and playlist grids derive the segment length from this fps, so a missing
   * value would drop them onto the integer grid and drift the audio off the
   * video IDR cadence on a fractional-fps source.
   */
  private parseFrameRate(rate?: string, avgRate?: string): string | undefined {
    const normalise = (r?: string): string | undefined => {
      if (!r || r === '0/0') return undefined;
      const parts = r.split('/');
      const num = Number(parts[0]);
      const den = Number(parts[1]);
      if (!den || !num) return r;
      const fps = num / den;
      return fps > 0
        ? fps.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
        : undefined;
    };
    return normalise(rate) ?? normalise(avgRate);
  }

  /**
   * Detect hardcoded black bars (letterbox) using ffmpeg cropdetect.
   * Samples multiple points in the video for accuracy.
   * Returns crop info if significant bars are found, null otherwise.
   */
  async detectCrop(
    videoPath: string,
    durationSeconds?: number,
    originalWidth?: number,
    originalHeight?: number,
    isHdr = false,
  ): Promise<CropInfo | null> {
    const label = path.basename(videoPath);
    this.logger.log(
      `cropdetect started for "${label}" (${originalWidth}x${originalHeight}, hdr=${isHdr})`,
    );
    try {
      // Sample 6 timestamps spread across the file (5–80%) — animated 4K
      // Blurays often mix full-frame action with cinema-aspect dialogue
      // scenes, and a tight 3-sample run repeatedly hit only full-frame
      // moments and reported 'no crop needed' on a clearly letterboxed
      // source. Six samples in parallel finish faster than
      // three sequential, so the wider coverage is free.
      const dur = durationSeconds ?? 600;
      const fractions = [0.05, 0.15, 0.3, 0.45, 0.6, 0.8];
      const timestamps = fractions.map((f) => Math.floor(dur * f));

      // limit (cropdetect threshold for "this pixel is black"):
      //   - SDR encodes black around luma 16 (BT.709 narrow range), so
      //     limit=24 is the legacy default and works.
      //   - HDR (PQ / HLG) encodes black around luma 50–70 — limit=24
      //     misses every 4K HDR Bluray we touched. limit=64 catches the
      //     letterbox but on SDR it pulls in low-luma scene content
      //     ('most of a dim scene is below 64') and falsely shrinks the
      //     crop. Pick per-source so neither side gets the wrong default.
      const limit = isHdr ? 64 : 24;

      // skip=24 drops the first 24 frames per pass so fades / transition
      // black don't shift the detected edges. round=16 keeps the result
      // mod-16 to match HW encoder constraints.
      const cropFilter = `cropdetect=limit=${limit}:round=16:reset=0:skip=24`;

      const sampleResults = await Promise.all(
        timestamps.map(async (ss) => {
          try {
            const { stderr } = await execFileAsync(
              'ffmpeg',
              [
                '-ss',
                String(Math.floor(ss)),
                '-i',
                videoPath,
                '-t',
                '5',
                '-vf',
                cropFilter,
                '-an',
                '-f',
                'null',
                '-',
              ],
              { timeout: 30_000 },
            );
            const lines = stderr.split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
              const m = lines[i].match(/crop=(\d+):(\d+):(\d+):(\d+)/);
              if (m) {
                return {
                  ss,
                  w: parseInt(m[1], 10),
                  h: parseInt(m[2], 10),
                  x: parseInt(m[3], 10),
                  y: parseInt(m[4], 10),
                };
              }
            }
            return null;
          } catch {
            return null;
          }
        }),
      );

      // Aggregate: pick the LARGEST crop observed (the loosest box that
      // still fits content). A small overlay on one sample can falsely
      // shrink the detected crop, but the largest area is the union of
      // content regions across scenes — what we actually want visible.
      let bestCrop: { w: number; h: number; x: number; y: number } | null =
        null;
      const seenSamples: string[] = [];
      for (const r of sampleResults) {
        if (!r) continue;
        seenSamples.push(`@${r.ss}s=${r.w}:${r.h}:${r.x}:${r.y}`);
        if (!bestCrop || r.w * r.h > bestCrop.w * bestCrop.h) {
          bestCrop = { w: r.w, h: r.h, x: r.x, y: r.y };
        }
      }

      if (!bestCrop) return null;
      const { w, h, x, y } = bestCrop;
      this.logger.debug(
        `cropdetect "${label}" samples: ${seenSamples.join(', ')}`,
      );

      // Only crop if bars are significant (> 40px total removed on at least one axis)
      const totalVerticalCrop = originalHeight ? originalHeight - h : y * 2;
      const totalHorizontalCrop = originalWidth ? originalWidth - w : x * 2;
      if (totalVerticalCrop < 40 && totalHorizontalCrop < 40) {
        this.logger.log(
          `cropdetect "${label}": no crop needed (detected ${w}:${h}:${x}:${y}, total crop: ${totalVerticalCrop}v/${totalHorizontalCrop}h)`,
        );
        return null;
      }

      this.logger.log(
        `cropdetect "${label}": crop needed → ${w}:${h}:${x}:${y} (removing ${totalVerticalCrop}px vertical, ${totalHorizontalCrop}px horizontal)`,
      );
      return { width: w, height: h, x, y };
    } catch (err) {
      this.logger.warn(`cropdetect failed for ${videoPath}: ${err}`);
      return null;
    }
  }
}
