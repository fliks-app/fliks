import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { StreamingService } from './streaming.service';
import { resolveSubtitleAbsolutePath } from '../subtitles/subtitle-path.util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const IMAGE_BASED_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'dvb_subtitle',
  'xsub',
]);

export interface BurnInInfo {
  /** 'text' for SRT/ASS/SSA, 'image' for PGS/VOBSUB */
  type: 'text' | 'image';
  /** Absolute path to the video file (used for embedded subs) */
  videoPath: string;
  /** Absolute path to the subtitle file (for external or extracted subs) */
  subtitlePath?: string;
  /** Stream index in the video file (for embedded subs via si= filter) */
  streamIndex?: number;
  /** Original codec name */
  codec: string;
}

@Injectable()
export class SubtitleBurnInService {
  private readonly log = new Logger(SubtitleBurnInService.name);
  private readonly tmpDir = '/tmp/suitarr-burn-in';

  constructor(
    @InjectRepository(SubtitleFile)
    private readonly subtitleFileRepo: Repository<SubtitleFile>,
    private readonly streamingService: StreamingService,
  ) {
    fs.mkdir(this.tmpDir, { recursive: true }).catch(() => {});
  }

  /**
   * Resolve burn-in info for a subtitle (external file or embedded stream).
   */
  async resolve(subtitleId: number, mediaFileId: number): Promise<BurnInInfo> {
    const sub = await this.subtitleFileRepo.findOne({
      where: { id: subtitleId },
    });
    if (!sub) throw new NotFoundException(`Subtitle #${subtitleId} not found`);

    const resolved = await this.streamingService.resolveFile(mediaFileId);
    const videoPath = resolved.absolutePath;
    const isImage = IMAGE_BASED_CODECS.has(sub.codec ?? '');

    if (sub.relativePath) {
      // External subtitle file
      const mediaPath = resolved.media.path ?? null;
      const absolute = resolveSubtitleAbsolutePath(mediaPath, sub.relativePath);
      if (!absolute) {
        this.log.error(
          `Burn-in subtitle #${subtitleId}: cannot resolve under media (relativePath="${sub.relativePath}")`,
        );
        throw new NotFoundException('Subtitle file not found on disk');
      }
      let realPath: string;
      try {
        realPath = await fs.realpath(absolute);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.log.error(
          `Burn-in subtitle #${subtitleId}: file missing at "${absolute}" (relativePath="${sub.relativePath}") (${detail})`,
        );
        throw new NotFoundException('Subtitle file not found on disk');
      }
      return {
        type: isImage ? 'image' : 'text',
        videoPath,
        subtitlePath: realPath,
        codec: sub.codec ?? 'unknown',
      };
    }

    if (sub.streamIndex != null) {
      // Embedded subtitle
      if (isImage) {
        // Bitmap: reference stream index directly (FFmpeg overlay filter)
        return {
          type: 'image',
          videoPath,
          streamIndex: sub.streamIndex,
          codec: sub.codec ?? 'unknown',
        };
      }

      // Text embedded: extract to temp ASS file for the subtitles= filter
      const tmpPath = path.join(
        this.tmpDir,
        `${mediaFileId}-${sub.streamIndex}.ass`,
      );
      try {
        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-i',
            videoPath,
            '-map',
            `0:${sub.streamIndex}`,
            '-c:s',
            'ass',
            tmpPath,
          ],
          { timeout: 30_000 },
        );
      } catch (err) {
        this.log.error(
          `Failed to extract subtitle stream ${sub.streamIndex}: ${err}`,
        );
        throw new NotFoundException('Failed to extract embedded subtitle');
      }

      return {
        type: 'text',
        videoPath,
        subtitlePath: tmpPath,
        codec: sub.codec ?? 'unknown',
      };
    }

    throw new NotFoundException('Subtitle has no file path or stream index');
  }

  /**
   * Build the FFmpeg video filter string for burn-in.
   * Returns the filter to append to the -vf chain (for text subs)
   * or null if -filter_complex is needed (for image subs).
   */
  buildFilter(info: BurnInInfo): string | null {
    if (info.type === 'text') {
      if (info.subtitlePath) {
        // Escape special characters in path for FFmpeg filter
        const escaped = info.subtitlePath
          .replace(/\\/g, '\\\\')
          .replace(/:/g, '\\:')
          .replace(/'/g, "'\\''");
        const ext = path.extname(info.subtitlePath).toLowerCase();
        if (ext === '.ass' || ext === '.ssa') {
          return `ass='${escaped}'`;
        }
        return `subtitles='${escaped}'`;
      }
      // Embedded text with stream index (using video file as subtitle source)
      if (info.streamIndex != null) {
        const escaped = info.videoPath
          .replace(/\\/g, '\\\\')
          .replace(/:/g, '\\:')
          .replace(/'/g, "'\\''");
        return `subtitles='${escaped}':si=${info.streamIndex}`;
      }
    }
    // Image-based: needs -filter_complex, handled separately
    return null;
  }
}
