import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { stat } from 'fs/promises';
import * as path from 'path';
import { Repository } from 'typeorm';
import { withFfmpegSlot } from '../../../common/utils/ffmpeg-slots';
import { MediaFile } from '../../media/entities/media-file.entity';
import type { MediaFileInfo } from '../../subtitles/ffprobe.service';
import { sourceIsMpegTs } from '../../subtitles/video-packets';
import { MediaFileScan } from '../entities/media-file-scan.entity';
import { scanSource, type SourceScan } from '../transcoding/source-scan';

/** Identifies the bytes of a file as far as a scan or a cached segment goes. */
export function sourceVersion(st: { size: number; mtimeMs: number }): string {
  return `${st.size}-${st.mtimeMs}`;
}

export interface HeldScan {
  /** The file's scan, null until one of its current version is stored. */
  scan: SourceScan | null;
  /** `sourceVersion` of the file now, null when it can't be read. */
  version: string | null;
}

/** One whole-file read per file version (keyframes, clock break, AAC header
 *  changes), run as background work and stored; requests only look it up. */
@Injectable()
export class SourceScanService {
  private readonly log = new Logger(SourceScanService.name);
  private readonly inFlight = new Map<number, Promise<void>>();

  constructor(
    @InjectRepository(MediaFileScan)
    private readonly scans: Repository<MediaFileScan>,
    @InjectRepository(MediaFile)
    private readonly files: Repository<MediaFile>,
  ) {}

  /** The stored scan of the file as it is now. Never scans. */
  async lookup(mediaFileId: number, absolutePath: string): Promise<HeldScan> {
    let st: { size: number; mtimeMs: number };
    try {
      st = await stat(absolutePath);
    } catch (err) {
      this.log.warn(`Cannot stat ${absolutePath}: ${(err as Error).message}`);
      return { scan: null, version: null };
    }
    const row = await this.scans.findOne({ where: { mediaFileId } });
    const current = row?.size === st.size && row.mtimeMs === st.mtimeMs;
    return { scan: current ? row.scan : null, version: sourceVersion(st) };
  }

  /** Scan the file unless its current version was, in the background budget.
   *  Never rejects. */
  scheduleIfNeeded(
    mediaFileId: number,
    absolutePath: string,
    streamInfo: MediaFileInfo | null | undefined,
  ): Promise<void> {
    if (!streamInfo?.video?.[0]) return Promise.resolve();
    let scan = this.inFlight.get(mediaFileId);
    if (!scan) {
      scan = this.scan(mediaFileId, absolutePath, streamInfo).finally(() =>
        this.inFlight.delete(mediaFileId),
      );
      this.inFlight.set(mediaFileId, scan);
    }
    return scan;
  }

  private async scan(
    mediaFileId: number,
    absolutePath: string,
    streamInfo: MediaFileInfo,
  ): Promise<void> {
    const label = path.basename(absolutePath);
    try {
      if ((await this.lookup(mediaFileId, absolutePath)).scan) return;
      const before = await stat(absolutePath);
      let t0 = 0;
      const scan = await withFfmpegSlot(() => {
        t0 = Date.now();
        return scanSource(absolutePath, streamInfo, { background: true });
      });
      const after = await stat(absolutePath);
      if (sourceVersion(after) !== sourceVersion(before)) {
        this.log.warn(`"${label}" changed while it was scanned; scan dropped`);
        return;
      }
      await this.scans.upsert(
        { mediaFileId, size: after.size, mtimeMs: after.mtimeMs, scan },
        ['mediaFileId'],
      );
      this.log.log(
        `"${label}" scanned in ${Date.now() - t0} ms: ${scan.keyframes.length} keyframes`,
      );
      if (sourceIsMpegTs(streamInfo, absolutePath)) await this.storeClockBreak(mediaFileId, label, scan);
    } catch (err) {
      this.log.warn(`Source scan failed for "${label}": ${(err as Error).message}`);
    }
  }

  /** The timeline reads the break off the stream info (`sourceTimeline`). */
  private async storeClockBreak(mediaFileId: number, label: string, scan: SourceScan) {
    // Re-read: a rescan may have replaced the stream info meanwhile.
    const file = await this.files.findOne({ where: { id: mediaFileId } });
    if (!file?.streamInfo) return;
    await this.files.update(mediaFileId, {
      streamInfo: { ...file.streamInfo, timestampBreakSeconds: scan.breakSeconds ?? null },
    });
    if (scan.breakSeconds != null) {
      this.log.warn(`"${label}": the timestamps break at ${scan.breakSeconds}s; playback ends there`);
    }
  }
}
