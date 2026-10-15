import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { stat } from 'fs/promises';
import { Repository } from 'typeorm';
import { MediaFile } from '../../media/entities/media-file.entity';
import { FfprobeService } from '../../media-probe/ffprobe.service';
import { SourceScanService, sourceVersion } from './source-scan.service';

/** Re-probes a row the engine reports stale (`hints.probeStale`), in the background, deduped per
 *  file. Never blocks the caller. */
@Injectable()
export class StaleProbeRescanService {
  private readonly log = new Logger(StaleProbeRescanService.name);
  private readonly inFlight = new Map<number, Promise<void>>();
  /** Files whose re-probe came back rejected or threw, this process run.
   *  Without this a broken re-probe retries, and fails, on every play. */
  private readonly rejected = new Set<number>();

  constructor(
    private readonly ffprobe: FfprobeService,
    @InjectRepository(MediaFile)
    private readonly files: Repository<MediaFile>,
    private readonly sourceScans: SourceScanService,
  ) {}

  /** Re-probes `mediaFileId` the engine flagged stale. No-op while an attempt for the same file is
   *  in flight, or a past attempt for it was rejected/failed. */
  schedule(mediaFileId: number, absolutePath: string): Promise<void> {
    if (this.rejected.has(mediaFileId)) return Promise.resolve();
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
      const fresh = await this.ffprobe.detectMediaFileInfo(absolutePath);
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
      // A no-op unless the scan is missing or stale: the bytes (hence its
      // stored version) didn't change, only the streamInfo just fixed above.
      void this.sourceScans.scheduleIfNeeded(mediaFileId, absolutePath, fresh);
    } catch (err) {
      this.log.warn(
        `Background re-probe failed for file #${mediaFileId}: ${(err as Error).message}`,
      );
      this.rejected.add(mediaFileId);
      // The keyframe scan doesn't depend on this backfill succeeding.
      try {
        const file = await this.files.findOne({ where: { id: mediaFileId } });
        if (file?.streamInfo) {
          void this.sourceScans.scheduleIfNeeded(mediaFileId, absolutePath, file.streamInfo);
        }
      } catch {
        /* best-effort: the file row itself is unreachable too */
      }
    }
  }
}
