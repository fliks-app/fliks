import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { stat } from 'fs/promises';
import { Repository } from 'typeorm';
import { withFfmpegSlot } from '../../../common/utils/ffmpeg-slots';
import { MediaFile } from '../../media/entities/media-file.entity';
import { FfprobeService, type MediaFileInfo } from '../../subtitles/ffprobe.service';
import { SourceScanService, sourceVersion } from './source-scan.service';

/** True once a row predates `formatName`, or an HDR row predates `hdr10Plus`:
 *  either absence alone flags it stale. */
export function needsReprobe(si: MediaFileInfo | null | undefined): boolean {
  const v = si?.video?.[0];
  if (!si || !v) return false;
  if (!si.formatName) return true;
  return !!v.hdrFormat && v.hdr10Plus === undefined;
}

/** Backfills a stale row's probe fields in the background, deduped per file
 *  under the shared ffmpeg slot budget. Never blocks the caller. */
@Injectable()
export class StaleProbeRescanService {
  private readonly log = new Logger(StaleProbeRescanService.name);
  private readonly inFlight = new Map<number, Promise<void>>();
  /** Files whose re-probe came back rejected or threw, this process run.
   *  Without this a broken re-probe retries — and fails — on every play. */
  private readonly rejected = new Set<number>();

  constructor(
    private readonly ffprobe: FfprobeService,
    @InjectRepository(MediaFile)
    private readonly files: Repository<MediaFile>,
    private readonly sourceScans: SourceScanService,
  ) {}

  /** Re-probes `mediaFileId` when `streamInfo` needs it, else resolves immediately.
   *  No-op while an attempt for the same file is already in flight, or a past
   *  attempt for it was rejected/failed. */
  scheduleIfNeeded(
    mediaFileId: number,
    absolutePath: string,
    streamInfo: MediaFileInfo | null | undefined,
  ): Promise<void> {
    if (!needsReprobe(streamInfo) || this.rejected.has(mediaFileId)) {
      return Promise.resolve();
    }
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
      const before = await stat(absolutePath);
      const fresh = await withFfmpegSlot(() =>
        this.ffprobe.detectMediaFileInfo(absolutePath),
      );
      const after = await stat(absolutePath);
      if (sourceVersion(before) !== sourceVersion(after)) {
        this.log.warn(`"${absolutePath}" changed during re-probe; result dropped`);
        return;
      }
      const file = await this.files.findOne({ where: { id: mediaFileId } });
      if (!file?.streamInfo) return;
      const hadVideo = !!file.streamInfo.video?.[0];
      if (fresh.error || !fresh.formatName || (hadVideo && !fresh.video[0])) {
        this.log.warn(
          `Re-probe of "${absolutePath}" (file #${mediaFileId}) looks broken: ` +
            `${fresh.error ?? 'no video stream detected'}; keeping the stored streamInfo`,
        );
        this.rejected.add(mediaFileId);
        // The keyframe scan is independent of the fields this backfill fixes;
        // a rejected re-probe must not also block it on the existing row.
        void this.sourceScans.scheduleIfNeeded(mediaFileId, absolutePath, file.streamInfo);
        return;
      }
      // Detected separately (cropdetect / the keyframe scan), never part of a
      // plain ffprobe, carried over so this backfill can't regress them.
      const prevCrop = file.streamInfo.video?.[0]?.crop;
      if (prevCrop && fresh.video[0]) fresh.video[0].crop = prevCrop;
      if (file.streamInfo.timestampBreakSeconds != null) {
        fresh.timestampBreakSeconds = file.streamInfo.timestampBreakSeconds;
      }
      await this.files.update(mediaFileId, { streamInfo: fresh });
      this.log.log(`Re-probed stale streamInfo for file #${mediaFileId} "${absolutePath}"`);
      // The prior scan (if any) ran against the stale row; redo it fresh now.
      void this.sourceScans.scheduleIfNeeded(mediaFileId, absolutePath, fresh);
    } catch (err) {
      this.log.warn(
        `Background re-probe failed for file #${mediaFileId}: ${(err as Error).message}`,
      );
      this.rejected.add(mediaFileId);
    }
  }
}
