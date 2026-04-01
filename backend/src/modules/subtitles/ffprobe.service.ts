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

interface FfprobeStream {
  index: number;
  codec_name?: string;
  codec_type?: string;
  tags?: { language?: string; title?: string };
  disposition?: { forced?: number; hearing_impaired?: number };
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
}
