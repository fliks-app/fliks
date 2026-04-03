import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';

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
}

export interface MediaFileInfo {
  video: VideoStreamInfo[];
  audio: AudioStreamInfo[];
  subtitles: SubtitleStreamInfo[];
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
        [
          '-v', 'error',
          '-print_format', 'json',
          '-show_streams',
          videoPath,
        ],
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
    } catch (err) {
      const e = err as any;
      this.logger.warn(
        `ffprobe streams detection failed for "${videoPath}": ${e.message}${e.stderr ? `\n  stderr: ${e.stderr}` : ''}`,
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
        format?: { duration?: string };
      };
      const streams = parsed.streams ?? [];
      const durationSeconds = parsed.format?.duration
        ? Number(parsed.format.duration)
        : undefined;

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
        }));

      if (!video.length && !audio.length) {
        return { video: [], audio: [], subtitles: [], durationSeconds, error: 'No streams detected' };
      }
      return { video, audio, subtitles, durationSeconds };
    } catch (err) {
      const e = err as any;
      const message = e.stderr?.trim() || e.message || String(err);
      this.logger.warn(
        `ffprobe file info failed for "${videoPath}": ${message}`,
      );
      return { video: [], audio: [], subtitles: [], error: message };
    }
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
}
