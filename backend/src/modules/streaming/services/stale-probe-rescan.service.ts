import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { withFfmpegSlot } from '../../../common/utils/ffmpeg-slots';
import { MediaFile } from '../../media/entities/media-file.entity';
import { FfprobeService, type MediaFileInfo } from '../../subtitles/ffprobe.service';

/** A stored probe predates a field the timeline math now relies on (see
 *  source-timeline.ts), so it keeps falling back to the video `start_time`
 *  until the file is re-probed. */
export function needsReprobe(si: MediaFileInfo | null | undefined): boolean {
  if (!si?.video?.[0]) return false;
  if (!si.formatName) return true;
  if (si.video[0].firstFrameSeconds === undefined) return true;
  if (si.formatStartSeconds === undefined) return true;
  return (si.audio ?? []).some((a) => a.startTimeSeconds === undefined);
}

/** Backfills a stale row's probe fields in the background, off the request
 *  that noticed it: deduped per file, under the shared ffmpeg slot budget , 
 *  same shape as SourceScanService's keyframe scan. Never blocks the caller. */
@Injectable()
export class StaleProbeRescanService {
  private readonly log = new Logger(StaleProbeRescanService.name);
  private readonly inFlight = new Map<number, Promise<void>>();

  constructor(
    private readonly ffprobe: FfprobeService,
    @InjectRepository(MediaFile)
    private readonly files: Repository<MediaFile>,
  ) {}

  /** Re-probes `mediaFileId` when `streamInfo` needs it, or resolves
   *  immediately: the caller discards this with `void`, never awaits it, so
   *  it never blocks playback-info. No-op while an attempt for the same file
   *  is already in flight. */
  scheduleIfNeeded(
    mediaFileId: number,
    absolutePath: string,
    streamInfo: MediaFileInfo | null | undefined,
  ): Promise<void> {
    if (!needsReprobe(streamInfo)) return Promise.resolve();
    let attempt = this.inFlight.get(mediaFileId);
    if (!attempt) {
      attempt = this.reprobe(mediaFileId, absolutePath).finally(() =>
        this.inFlight.delete(mediaFileId),
      );
      this.inFlight.set(mediaFileId, attempt);
    }
    return attempt;
  }

  private async reprobe(mediaFileId: number, absolutePath: string): Promise<void> {
    try {
      const fresh = await withFfmpegSlot(() =>
        this.ffprobe.detectMediaFileInfo(absolutePath),
      );
      const file = await this.files.findOne({ where: { id: mediaFileId } });
      if (!file?.streamInfo) return;
      // Detected separately (cropdetect / the keyframe scan), never part of a
      // plain ffprobe, carried over so this backfill can't regress them.
      const prevCrop = file.streamInfo.video?.[0]?.crop;
      if (prevCrop && fresh.video[0]) fresh.video[0].crop = prevCrop;
      if (file.streamInfo.timestampBreakSeconds != null) {
        fresh.timestampBreakSeconds = file.streamInfo.timestampBreakSeconds;
      }
      await this.files.update(mediaFileId, { streamInfo: fresh });
      this.log.log(`Re-probed stale streamInfo for file #${mediaFileId} "${absolutePath}"`);
    } catch (err) {
      this.log.warn(
        `Background re-probe failed for file #${mediaFileId}: ${(err as Error).message}`,
      );
    }
  }
}
