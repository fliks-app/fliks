import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { freeFfmpegSlots } from '../../../common/utils/ffmpeg-slots';
import { MediaFile } from '../../media/entities/media-file.entity';
import { StreamingService } from '../streaming.service';
import { SourceScanService } from './source-scan.service';
import { LiveSessionRegistry } from '../live-session.service';

const BOOT_DELAY_MS = 5 * 60_000;

/** Backfills the keyframe scan for files imported before it ran at import
 *  time, one file per tick, so the first post-upgrade play of an old file
 *  isn't stuck on the uniform remux grid. Internal housekeeping, like
 *  `SchedulerService.pruneOldCommands`: no admin setting, nothing to trigger. */
@Injectable()
export class ScanBackfillService {
  private readonly log = new Logger(ScanBackfillService.name);
  private running = false;
  /** Highest id attempted this process run: a file whose scan fails or no-ops
   *  leaves no row, and must not come back every minute. */
  private cursor = 0;
  private readonly startedAt = Date.now();

  constructor(
    @InjectRepository(MediaFile)
    private readonly files: Repository<MediaFile>,
    private readonly streamingService: StreamingService,
    private readonly sourceScans: SourceScanService,
    private readonly liveSessions: LiveSessionRegistry,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    // One scan in flight from this service at a time; a whole-file scan can
    // run for minutes, well past this interval.
    if (this.running) return;
    // Boot already runs its own probes; housekeeping waits for them.
    if (Date.now() - this.startedAt < BOOT_DELAY_MS) return;
    // A live session may start mid-scan; the scan already run isn't pulled
    // back, but no new one starts until the account is idle again.
    if (this.liveSessions.size() > 0) return;
    // Leave at least one slot free: a background scan must never be the one
    // that makes an interactive job wait behind it in the FIFO queue.
    if (freeFfmpegSlots() <= 1) return;

    this.running = true;
    try {
      const id = await this.nextPending();
      if (id == null) return;
      this.cursor = id;
      const resolved = await this.streamingService.resolveFile(id).catch((err: Error) => {
        this.log.warn(`Scan backfill: file #${id} unresolvable, skipping: ${err.message}`);
        return null;
      });
      if (!resolved) return;
      await this.sourceScans.scheduleIfNeeded(
        id,
        resolved.absolutePath,
        resolved.mediaFile.streamInfo,
      );
    } finally {
      this.running = false;
    }
  }

  /** Next file past the cursor with no `media_file_scans` row and a probed
   *  video track, the only files `scheduleIfNeeded` scans. */
  private async nextPending(): Promise<number | null> {
    const rows: { id: number }[] = await this.files.query(
      `
      SELECT mf.id FROM media_files mf
      LEFT JOIN media_file_scans mfs ON mfs."mediaFileId" = mf.id
      WHERE mfs.id IS NULL
        AND mf.id > $1
        AND mf."streamInfo" -> 'video' -> 0 IS NOT NULL
      ORDER BY mf.id ASC
      LIMIT 1
    `,
      [this.cursor],
    );
    return rows[0]?.id ?? null;
  }
}
