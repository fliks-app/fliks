import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

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

export interface MediaFileInfo {
  video: VideoStreamInfo[];
  audio: AudioStreamInfo[];
  subtitles: SubtitleStreamInfo[];
  /** Overall container bitrate from ffprobe `format.bit_rate` (bits/s). */
  formatBitRate?: number;
  durationSeconds?: number;
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
        language: s.tags?.language ?? 'und',
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
          language: s.tags?.language ?? 'und',
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
          videoPath,
        ],
        { timeout: 30_000 },
      );

      const parsed = JSON.parse(stdout) as {
        streams?: FfprobeStream[];
        format?: { duration?: string; bit_rate?: string };
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
          hdrFormat: this.deriveHdrFormat(
            s.color_transfer,
            s.color_primaries,
            s.bits_per_raw_sample ? Number(s.bits_per_raw_sample) : undefined,
            s.pix_fmt,
            s.profile,
          ),
        }));

      const audio: AudioStreamInfo[] = streams
        .filter((s) => s.codec_type === 'audio')
        .map((s) => ({
          streamIndex: s.index,
          codec: s.codec_name ?? 'unknown',
          language: s.tags?.language ?? 'und',
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
          language: s.tags?.language ?? 'und',
          title: s.tags?.title,
          forced: s.disposition?.forced === 1,
          hearingImpaired: s.disposition?.hearing_impaired === 1,
          isImageBased: IMAGE_BASED_SUBTITLE_CODECS.has(s.codec_name ?? ''),
        }));

      if (!video.length && !audio.length) {
        return {
          video: [],
          audio: [],
          subtitles: [],
          formatBitRate,
          durationSeconds,
          error: 'No streams detected',
        };
      }
      return { video, audio, subtitles, formatBitRate, durationSeconds };
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
    bitDepth?: number,
    pixelFormat?: string,
    profile?: string,
  ): HdrFormat | undefined {
    if (!colorTransfer) return undefined;
    // Determine if 10-bit from bitDepth, pixel format, or codec profile
    const is10bit =
      (bitDepth && bitDepth >= 10) ||
      (pixelFormat && /10le|10be|p010/.test(pixelFormat)) ||
      (profile && /main 10|main10/i.test(profile));
    if (!is10bit) return undefined;
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
  ): Promise<CropInfo | null> {
    const label = path.basename(videoPath);
    this.logger.log(`cropdetect started for "${label}" (${originalWidth}x${originalHeight})`);
    try {
      // Sample at 3 different timestamps to avoid false positives (dark scenes, credits)
      const dur = durationSeconds ?? 600;
      const timestamps = [
        Math.min(60, dur * 0.1), // 10% or 60s
        Math.min(300, dur * 0.3), // 30% or 300s
        Math.min(600, dur * 0.5), // 50% or 600s
      ];

      const cropCounts = new Map<string, number>();

      for (const ss of timestamps) {
        try {
          const { stderr } = await execFileAsync(
            'ffmpeg',
            [
              '-ss',
              String(Math.floor(ss)),
              '-i',
              videoPath,
              '-t',
              '3',
              '-vf',
              'cropdetect=24:16:0',
              '-an',
              '-f',
              'null',
              '-',
            ],
            { timeout: 30_000 },
          );

          // Parse last crop= line
          const lines = stderr.split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            const m = lines[i].match(/crop=(\d+):(\d+):(\d+):(\d+)/);
            if (m) {
              const key = `${m[1]}:${m[2]}:${m[3]}:${m[4]}`;
              cropCounts.set(key, (cropCounts.get(key) ?? 0) + 1);
              break;
            }
          }
        } catch {
          // Individual sample failed, continue
        }
      }

      if (!cropCounts.size) return null;

      // Pick the most common crop value
      let bestCrop = '';
      let bestCount = 0;
      for (const [crop, count] of cropCounts) {
        if (count > bestCount) {
          bestCrop = crop;
          bestCount = count;
        }
      }

      const parts = bestCrop.split(':').map(Number);
      if (parts.length !== 4) return null;
      const [w, h, x, y] = parts;

      // Only crop if bars are significant (> 40px total removed on at least one axis)
      const totalVerticalCrop = originalHeight ? originalHeight - h : y * 2;
      const totalHorizontalCrop = originalWidth ? originalWidth - w : x * 2;
      if (totalVerticalCrop < 40 && totalHorizontalCrop < 40) {
        this.logger.log(`cropdetect "${label}": no crop needed (detected ${bestCrop}, total crop: ${totalVerticalCrop}v/${totalHorizontalCrop}h)`);
        return null;
      }

      this.logger.log(`cropdetect "${label}": crop needed → ${w}:${h}:${x}:${y} (removing ${totalVerticalCrop}px vertical, ${totalHorizontalCrop}px horizontal)`);
      return { width: w, height: h, x, y };
    } catch (err) {
      this.logger.warn(`cropdetect failed for ${videoPath}: ${err}`);
      return null;
    }
  }
}
