import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { StreamingService } from './streaming.service';
import { resolveSubtitleAbsolutePath } from '../subtitles/subtitle-path.util';
import { isImageBasedSubtitleCodec } from '../../common/constants/subtitle-codecs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { sourceTimeline } from '../media-tools/source-timeline';

export interface BurnInInfo {
  /** 'text' for SRT/ASS/SSA, 'image' for PGS/VOBSUB */
  type: 'text' | 'image';
  /** Absolute path to the video file (used for embedded subs) */
  videoPath: string;
  /** Absolute path to the subtitle file (for external or extracted subs) */
  subtitlePath?: string;
  /** Stream index in the video file (image subs overlaid by index) */
  streamIndex?: number;
  /** Position among the video's subtitle streams: what the `si=` filter of an embedded text track counts. */
  subtitleOrdinal?: number;
  /** Original codec name */
  codec: string;
  /** Source time cue 0 of a text file sits at (the container start). */
  cueOffsetSeconds?: number;
}

/** What the engine's `OpenSessionRequest.burnIn` carries. */
export interface BurnInSubtitle {
  /** `-vf` filter for a text subtitle, null for an image one (overlaid from `streamIndex`). */
  filter: string | null;
  streamIndex?: number;
  type: 'text' | 'image';
}

/** Seconds as a signed `setpts` term, microsecond precision. */
function ptsTerm(sign: 1 | -1, seconds: number): string {
  const v = sign * seconds;
  return `${v < 0 ? '-' : '+'}${Number(Math.abs(v).toFixed(6))}/TB`;
}

/** Render `subtitleFilter` against cue time: under `-copyts` frames carry
 *  source PTS, which libass would read as cue time. */
export function atCueTime(subtitleFilter: string, cueOffsetSeconds = 0): string {
  if (cueOffsetSeconds === 0) return subtitleFilter;
  return (
    `setpts=PTS${ptsTerm(-1, cueOffsetSeconds)},${subtitleFilter},` +
    `setpts=PTS${ptsTerm(1, cueOffsetSeconds)}`
  );
}

@Injectable()
export class SubtitleBurnInService {
  private readonly log = new Logger(SubtitleBurnInService.name);

  constructor(
    @InjectRepository(SubtitleFile)
    private readonly subtitleFileRepo: Repository<SubtitleFile>,
    private readonly streamingService: StreamingService,
  ) {}

  /**
   * Resolve burn-in info for a subtitle (external file or embedded stream).
   */
  async resolve(subtitleId: number, mediaFileId: number): Promise<BurnInInfo> {
    const sub = await this.subtitleFileRepo.findOne({
      where: { id: subtitleId },
    });
    if (!sub || sub.mediaFileId !== mediaFileId) {
      throw new NotFoundException(`Subtitle #${subtitleId} not found`);
    }

    const resolved = await this.streamingService.resolveFile(mediaFileId);
    const videoPath = resolved.absolutePath;
    const isImage = isImageBasedSubtitleCodec(sub.codec);
    const cueOffsetSeconds = sourceTimeline(
      resolved.mediaFile.streamInfo,
      videoPath,
    ).formatStart;

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
        cueOffsetSeconds,
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

      // Text embedded: the engine's ffmpeg reads the track from the video itself (`si=` filter).
      const subtitleOrdinal = resolved.mediaFile.streamInfo?.subtitles?.findIndex(
        (s) => s.streamIndex === sub.streamIndex,
      );
      if (subtitleOrdinal == null || subtitleOrdinal < 0) {
        throw new NotFoundException('Embedded subtitle not found in the probed streams');
      }
      return {
        type: 'text',
        videoPath,
        streamIndex: sub.streamIndex,
        subtitleOrdinal,
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
        const filter =
          ext === '.ass' || ext === '.ssa'
            ? `ass='${escaped}'`
            : `subtitles='${escaped}'`;
        return atCueTime(filter, info.cueOffsetSeconds);
      }
      // Embedded text: the video file is the subtitle source
      if (info.subtitleOrdinal != null) {
        const escaped = info.videoPath
          .replace(/\\/g, '\\\\')
          .replace(/:/g, '\\:')
          .replace(/'/g, "'\\''");
        return `subtitles='${escaped}':si=${info.subtitleOrdinal}`;
      }
    }
    // Image-based: needs -filter_complex, handled separately
    return null;
  }
}
