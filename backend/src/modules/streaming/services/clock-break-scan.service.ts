import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as path from 'path';
import { Repository } from 'typeorm';
import { MediaFile } from '../../media/entities/media-file.entity';
import type { MediaFileInfo } from '../../subtitles/ffprobe.service';
import { sourceIsMpegTs, videoPackets } from '../../subtitles/video-packets';

/**
 * Finds where an MPEG-TS clock breaks, which takes reading every packet of the
 * file: off the import path, as a background ffmpeg job, stored on the row
 * (`timestampBreakSeconds`, null for none). The keyframe grid of a remux
 * played meanwhile shares the same read.
 */
@Injectable()
export class ClockBreakScanService {
  private readonly log = new Logger(ClockBreakScanService.name);
  private readonly inFlight = new Map<number, Promise<void>>();

  constructor(
    @InjectRepository(MediaFile)
    private readonly files: Repository<MediaFile>,
  ) {}

  /** Scan the file unless it was, or isn't MPEG-TS. Never rejects. */
  scheduleIfNeeded(
    mediaFileId: number,
    absolutePath: string,
    streamInfo: MediaFileInfo | null | undefined,
  ): Promise<void> {
    if (!needsScan(streamInfo, absolutePath)) return Promise.resolve();
    let scan = this.inFlight.get(mediaFileId);
    if (!scan) {
      scan = this.scan(mediaFileId, absolutePath).finally(() =>
        this.inFlight.delete(mediaFileId),
      );
      this.inFlight.set(mediaFileId, scan);
    }
    return scan;
  }

  private async scan(mediaFileId: number, absolutePath: string): Promise<void> {
    const label = path.basename(absolutePath);
    try {
      const v = (await this.files.findOne({ where: { id: mediaFileId } }))?.streamInfo?.video?.[0];
      if (!v) return;
      const { breakSeconds } = await videoPackets(
        absolutePath,
        { streamIndex: v.streamIndex, reorderFrames: v.reorderFrames, avgFrameRate: v.avgFrameRate },
        { mpegTs: true, background: true },
      );
      // Re-read: a rescan may have replaced the stream info meanwhile.
      const file = await this.files.findOne({ where: { id: mediaFileId } });
      if (!file?.streamInfo) return;
      await this.files.update(mediaFileId, {
        streamInfo: { ...file.streamInfo, timestampBreakSeconds: breakSeconds ?? null },
      });
      if (breakSeconds != null) {
        this.log.warn(`"${label}": the timestamps break at ${breakSeconds}s; playback ends there`);
      }
    } catch (err) {
      this.log.warn(`Clock break scan failed for "${label}": ${(err as Error).message}`);
    }
  }
}

function needsScan(si: MediaFileInfo | null | undefined, absolutePath: string): boolean {
  return !!si?.video?.[0] && si.timestampBreakSeconds === undefined && sourceIsMpegTs(si, absolutePath);
}
