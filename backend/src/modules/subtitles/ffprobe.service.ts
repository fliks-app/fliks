import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { inferLanguageCodeFromTitle } from '../../common/release-parsing/language.parser';

const execFileAsync = promisify(execFile);

export interface EmbeddedSubtitleStream {
  streamIndex: number;
  codec: string;
  language: string;
  forced: boolean;
  hearingImpaired: boolean;
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
  bitRate?: number;
  bitDepth?: number;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  hdrFormat?: HdrFormat;
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

const IMAGE_BASED_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'dvb_subtitle',
  'xsub',
]);

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
  bit_rate?: string;
  bits_per_raw_sample?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  tags?: { language?: string; title?: string };
  disposition?: {
    forced?: number;
    hearing_impaired?: number;
    default?: number;
  };
}

/** Resolve the language code of an ffprobe stream. `tags.language` is the
 *  authoritative source when set to anything other than `und`; otherwise
 *  fall back to inferring from `tags.title` (Emby / Plex muxers commonly
 *  carry the language name in the title, e.g. `"French AC3 5.1"`). Stays
 *  on `und` when neither is conclusive — auto-pick logic downstream
 *  handles the unknown-language case by ordering / size heuristics. */
function resolveStreamLanguage(s: {
  tags?: { language?: string; title?: string };
}): string {
  const explicit = s.tags?.language;
  if (explicit && explicit.toLowerCase() !== 'und') return explicit;
  return inferLanguageCodeFromTitle(s.tags?.title) ?? 'und';
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
        isImageBased: IMAGE_BASED_SUBTITLE_CODECS.has(s.codec_name ?? ''),
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
          title: s.tags?.title,
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
          tags?: { title?: string };
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
        .map((s) => ({
          streamIndex: s.index,
          codec: s.codec_name ?? 'unknown',
          profile: s.profile,
          level: s.level,
          width: s.width,
          height: s.height,
          displayAspectRatio: s.display_aspect_ratio,
          pixelFormat: s.pix_fmt,
          frameRate: this.parseFrameRate(s.r_frame_rate),
          bitRate: s.bit_rate ? Number(s.bit_rate) : undefined,
          bitDepth: s.bits_per_raw_sample
            ? Number(s.bits_per_raw_sample)
            : undefined,
          colorSpace: s.color_space,
          colorTransfer: s.color_transfer,
          colorPrimaries: s.color_primaries,
          hdrFormat: this.deriveHdrFormat(s.color_transfer, s.color_primaries),
        }));

      const audio: AudioStreamInfo[] = streams
        .filter((s) => s.codec_type === 'audio')
        .map((s) => ({
          streamIndex: s.index,
          codec: s.codec_name ?? 'unknown',
          language: resolveStreamLanguage(s),
          title: s.tags?.title,
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
          title: s.tags?.title,
          forced: s.disposition?.forced === 1,
          hearingImpaired: s.disposition?.hearing_impaired === 1,
          isImageBased: IMAGE_BASED_SUBTITLE_CODECS.has(s.codec_name ?? ''),
        }));

      const chapters: Chapter[] = (parsed.chapters ?? [])
        .map((c) => ({
          startSeconds: c.start_time ? Number(c.start_time) : 0,
          endSeconds: c.end_time ? Number(c.end_time) : 0,
          title: c.tags?.title,
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

  private parseFrameRate(rate?: string): string | undefined {
    if (!rate || rate === '0/0') return undefined;
    const parts = rate.split('/');
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (!den || !num) return rate;
    const fps = num / den;
    return fps > 0
      ? fps.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
      : undefined;
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
