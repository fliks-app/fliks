import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { getImagesDir } from '../../common/constants/paths';
import { EventsService } from '../scheduler/events.service';
import { ActivityRegistryService } from '../scheduler/activity-registry.service';
import { Command } from '../scheduler/entities/command.entity';
import {
  describeBackends,
  HWACCEL_AVAILABLE,
  pickExtractor,
  type CropArea,
} from './thumbnail-extractors';
import { TranscodingService } from './transcoding';
import { FFMPEG_SLOTS, withFfmpegSlot } from '../../common/utils/ffmpeg-slots';
import {
  buildMediaProgressSubject,
  formatMediaProgressSubject,
  type MediaProgressSubject,
} from '../../common/utils/media-progress-subject.util';

const execFileAsync = promisify(execFile);

/** Spawn with low I/O and CPU priority (ionice idle + nice 19) on Linux. */
function spawnLowPriority(cmd: string, args: string[]): ChildProcess {
  if (process.platform === 'linux') {
    return spawn('ionice', ['-c3', 'nice', '-n19', cmd, ...args]);
  }
  return spawn(cmd, args);
}

export interface SpriteMetadata {
  interval: number;
  columns: number;
  thumbWidth: number;
  thumbHeight: number;
  count: number;
}

const baseDir = () => path.join(getImagesDir(), 'thumbnails');
const framesTmpDir = () => path.join(getImagesDir(), 'thumbnails-tmp');

const COLUMNS = 10;
const THUMB_WIDTH = 240;

/** Max concurrent sprite generations */
const SPRITE_CONCURRENCY = 2;

interface QueueItem {
  mediaFileId: number;
  absolutePath: string;
  durationSeconds: number;
  subject: MediaProgressSubject;
  skipTracking?: boolean;
  crop?: CropArea;
  resolve: (meta: SpriteMetadata | null) => void;
}

@Injectable()
export class ThumbnailService {
  private readonly log = new Logger(ThumbnailService.name);
  private readonly generating = new Map<
    number,
    Promise<SpriteMetadata | null>
  >();
  private readonly queue: QueueItem[] = [];
  private running = 0;

  constructor(
    private readonly eventsService: EventsService,
    @InjectRepository(Command)
    private readonly commandRepo: Repository<Command>,
    private readonly transcoding: TranscodingService,
    private readonly activityRegistry: ActivityRegistryService,
  ) {
    this.log.log(
      `Thumbnail extraction backends: ${describeBackends()} (FFMPEG_SLOTS=${FFMPEG_SLOTS}, SPRITE_CONCURRENCY=${SPRITE_CONCURRENCY})`,
    );
  }

  /** Pick the frame extractor, forcing the CPU path while a live transcode is
   *  using the GPU. HW sprite decodes share the same render node as the
   *  transcode's decode/VPP pipeline with no GPU budget between them, so an
   *  unguarded sprite burst starves (or, on QSV, kills) the live session. */
  private chooseExtractor(crop?: CropArea) {
    return pickExtractor(
      crop,
      HWACCEL_AVAILABLE && this.transcoding.hasActiveTranscode(),
    );
  }

  /**
   * Convenience wrapper that resolves the absolute file path + sprite label
   * from domain entities and calls {@link getOrGenerate}. Returns null when
   * the file has no probed duration or no path yet (we can't generate).
   * Shared by the scheduler bulk command and the post-import completion flow.
   */
  async generateForFile(
    file: {
      id: number;
      relativePath: string;
      streamInfo?: {
        durationSeconds?: number;
        video?: { crop?: CropArea }[];
      } | null;
    },
    media: { path: string | null; title: string },
    subject: MediaProgressSubject,
    options: { force?: boolean; skipTracking?: boolean } = {},
  ): Promise<SpriteMetadata | null> {
    const dur = file.streamInfo?.durationSeconds;
    const absPath =
      media.path && file.relativePath
        ? path.join(media.path, file.relativePath)
        : null;
    if (!dur || !absPath) return null;
    return this.getOrGenerate(
      file.id,
      absPath,
      dur,
      subject,
      options.force ?? false,
      options.skipTracking ?? false,
      file.streamInfo?.video?.[0]?.crop,
    );
  }

  async getOrGenerate(
    mediaFileId: number,
    absolutePath: string,
    durationSeconds: number,
    subject: MediaProgressSubject,
    force = false,
    skipTracking = false,
    crop?: CropArea,
  ): Promise<SpriteMetadata | null> {
    const dir = path.join(baseDir(), String(mediaFileId));
    const metaPath = path.join(dir, 'sprite.json');

    if (!force && existsSync(metaPath)) {
      try {
        return JSON.parse(await fsp.readFile(metaPath, 'utf-8'));
      } catch {
        // corrupted, regenerate
      }
    }

    if (this.generating.has(mediaFileId)) {
      return this.generating.get(mediaFileId)!;
    }

    this.activityRegistry.upsertPending(
      `GenerateSprite:${mediaFileId}`,
      'GenerateSprite',
      subject,
    );
    const promise = new Promise<SpriteMetadata | null>((resolve) => {
      this.queue.push({
        mediaFileId,
        absolutePath,
        durationSeconds,
        subject,
        skipTracking,
        crop,
        resolve,
      });
      this.processQueue();
    });

    this.generating.set(mediaFileId, promise);
    promise.finally(() => this.generating.delete(mediaFileId));
    return promise;
  }

  getSpritePath(mediaFileId: number): string {
    return path.join(baseDir(), String(mediaFileId), 'sprite.jpg');
  }

  getMetadataPath(mediaFileId: number): string {
    return path.join(baseDir(), String(mediaFileId), 'sprite.json');
  }

  /**
   * Read an existing sprite metadata without triggering generation.
   * Used by the streaming endpoints so opening the player doesn't kick off
   * a heavy thumbnail transcode in parallel. Sprite generation is done at
   * import/rescan (scheduler) or via the manual regenerate button.
   */
  async readExistingMeta(mediaFileId: number): Promise<SpriteMetadata | null> {
    const metaPath = path.join(baseDir(), String(mediaFileId), 'sprite.json');
    if (!existsSync(metaPath)) return null;
    try {
      return JSON.parse(await fsp.readFile(metaPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** Drop a file's sprite + metadata. Nothing regenerates them from an id
   *  that no longer exists, so a removed file would leak its sheet forever. */
  async deleteForFile(mediaFileId: number): Promise<void> {
    const dir = path.join(baseDir(), String(mediaFileId));
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch (err) {
      this.log.warn(
        `Sprite cleanup failed for file #${mediaFileId}: ${(err as Error).message}`,
      );
    }
  }

  private processQueue(): void {
    while (this.running < SPRITE_CONCURRENCY && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.running++;
      this.generate(
        item.mediaFileId,
        item.absolutePath,
        item.durationSeconds,
        item.subject,
        item.skipTracking,
        item.crop,
      )
        .then((meta) => item.resolve(meta))
        .catch((err) => {
          // Don't let unexpected failures stay silent — log stack then
          // resolve null so callers don't hang.
          this.log.error(
            `Sprite generation crashed (file #${item.mediaFileId}, "${item.subject.title}"): ${(err as Error).message}`,
            err instanceof Error ? err.stack : err,
          );
          item.resolve(null);
        })
        .finally(() => {
          this.running--;
          this.processQueue();
        });
    }
  }

  private async generate(
    mediaFileId: number,
    absolutePath: string,
    durationSeconds: number,
    subject: MediaProgressSubject,
    skipTracking = false,
    crop?: CropArea,
  ): Promise<SpriteMetadata | null> {
    const dir = path.join(baseDir(), String(mediaFileId));
    const spritePath = path.join(dir, 'sprite.jpg');
    const metaPath = path.join(dir, 'sprite.json');
    const interval = this.pickInterval(durationSeconds);
    const count = Math.ceil(durationSeconds / interval);
    const rows = Math.ceil(count / COLUMNS);
    const label = formatMediaProgressSubject(subject);
    const total = Math.round(durationSeconds);
    const progressKey = `GenerateSprite:${mediaFileId}`;
    this.activityRegistry.upsertRunning(progressKey, 'GenerateSprite', subject, 0, total);
    const t0 = Date.now();

    // Source file size + concurrent sprite jobs: useful to correlate slow
    // runs with I/O contention or large-file seek cost on HDD/network mounts.
    let srcSizeMb: number | null = null;
    try {
      const st = await fsp.stat(absolutePath);
      srcSizeMb = Math.round(st.size / (1024 * 1024));
    } catch {
      /* file disappeared or unreadable — generate() will fail with a clearer error */
    }
    // `this.running` was incremented in processQueue() before calling generate(),
    // so subtract 1 to get *other* sprite jobs running in parallel with this one.
    const otherRunning = Math.max(0, this.running - 1);

    // Ask the factory which backend will run, so the log line matches
    // exactly what ffmpeg sees per frame.
    const decode = this.chooseExtractor(crop).describe();
    this.log.log(
      `Sprite START for "${label}" (file #${mediaFileId}): ${count} thumbs @ ${interval}s interval, workers=${FFMPEG_SLOTS}, decode=${decode}, otherSprites=${otherRunning}, queued=${this.queue.length}, srcSize=${srcSizeMb ?? '?'}MB, crop=${
        crop ? `${crop.width}x${crop.height}+${crop.x},${crop.y}` : 'none'
      }, src=${absolutePath}`,
    );

    // Record task in DB (skip when called from batch command)
    let cmd: Command | null = null;
    if (!skipTracking) {
      cmd = await this.commandRepo.save(
        this.commandRepo.create({
          name: 'GenerateSprite',
          status: 'running',
          trigger: 'system',
          startedOn: new Date(),
          body: { mediaFileId, mediaTitle: label },
        }),
      );
      this.eventsService.emit({
        type: 'command.started',
        name: 'GenerateSprite',
      });
    }

    const framesDir = path.join(framesTmpDir(), String(mediaFileId));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.mkdir(framesDir, { recursive: true });

    // Kick off the progress bar immediately — seek-based extraction starts
    // fast but the frontend only shows the bar when it sees at least one
    // `task.progress` event.
    this.eventsService.emit({
      type: 'task.progress',
      command: progressKey,
      current: 0,
      total,
      message: label,
      subject,
    });

    // Global 10-minute timeout for the entire sprite (extraction + tiling).
    const SPRITE_TIMEOUT_MS = 10 * 60_000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Sprite generation timed out after 10 minutes`)),
        SPRITE_TIMEOUT_MS,
      ),
    );

    let extractMs = 0;
    let tileMs = 0;
    try {
      await Promise.race([
        (async () => {
          // Two-pass via seek: spawn N parallel `ffmpeg -ss` processes (one per
          // thumbnail timestamp) that extract a single frame each — much faster
          // than sequentially decoding the full video. Then tile the frames.
          const tExtract = Date.now();
          await this.extractFramesBySeek(
            absolutePath,
            framesDir,
            interval,
            count,
            total,
            label,
            subject,
            progressKey,
            crop,
          );
          extractMs = Date.now() - tExtract;

          const tTile = Date.now();
          await this.tileSprite(framesDir, spritePath, rows);
          tileMs = Date.now() - tTile;
          let spriteKb: number | null = null;
          try {
            const st = await fsp.stat(spritePath);
            spriteKb = Math.round(st.size / 1024);
          } catch {
            /* sprite missing — would have thrown above */
          }
          this.log.log(
            `Sprite TILE done for "${label}" in ${(tileMs / 1000).toFixed(2)}s (${count} frames → sprite.jpg, ${spriteKb ?? '?'}KB)`,
          );
        })(),
        timeoutPromise,
      ]);

      // Read actual dimensions via ffprobe
      let thumbHeight: number;
      try {
        const { stdout } = await execFileAsync('ffprobe', [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height',
          '-of',
          'csv=p=0',
          spritePath,
        ]);
        const [, h] = stdout.trim().split(',').map(Number);
        thumbHeight = rows > 0 ? Math.round(h / rows) : 90;
      } catch {
        thumbHeight = 90;
      }

      const meta: SpriteMetadata = {
        interval,
        columns: COLUMNS,
        thumbWidth: THUMB_WIDTH,
        thumbHeight,
        count,
      };

      await fsp.writeFile(metaPath, JSON.stringify(meta));
      const totalMs = Date.now() - t0;
      this.log.log(
        `Sprite DONE for "${label}" in ${(totalMs / 1000).toFixed(1)}s (${count} thumbs) — extract ${(extractMs / 1000).toFixed(1)}s, tile ${(tileMs / 1000).toFixed(2)}s, overhead ${((totalMs - extractMs - tileMs) / 1000).toFixed(2)}s`,
      );

      if (cmd) {
        cmd.status = 'completed';
        cmd.endedOn = new Date();
        await this.commandRepo.save(cmd);
        this.eventsService.emit({
          type: 'command.completed',
          name: 'GenerateSprite',
          status: 'completed',
        });
      }

      return meta;
    } catch (err) {
      const e = err as Error & { stderr?: string };
      const stderrTail = e.stderr
        ? `\n  ffmpeg stderr tail:\n${this.indent(e.stderr.trim().split('\n').slice(-15).join('\n'))}`
        : '';
      this.log.error(
        `Sprite FAILED for "${label}" (file #${mediaFileId}) after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}${stderrTail}`,
        e.stack,
      );
      if (cmd) {
        cmd.status = 'failed';
        cmd.endedOn = new Date();
        await this.commandRepo.save(cmd);
        this.eventsService.emit({
          type: 'command.completed',
          name: 'GenerateSprite',
          status: 'failed',
        });
      }
      return null;
    } finally {
      this.eventsService.emit({
        type: 'task.progress',
        command: progressKey,
        current: total,
        total,
        message: label,
        subject,
      });
      this.activityRegistry.remove(progressKey);
      // Cleanup tmp frames (fire-and-forget).
      fsp
        .rm(path.join(framesTmpDir(), String(mediaFileId)), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
    }
  }

  /**
   * Extract one frame per thumbnail timestamp by spawning N parallel
   * `ffmpeg -ss <ts>` processes. Each process only decodes the keyframe
   * around the seek point — dramatically faster than sequentially decoding
   * the full video for long files (2h+).
   */
  private async extractFramesBySeek(
    inputPath: string,
    framesDir: string,
    interval: number,
    count: number,
    totalSeconds: number,
    label: string,
    subject: MediaProgressSubject,
    progressKey: string,
    crop?: CropArea,
  ): Promise<void> {
    let completed = 0;
    let failed = 0;
    let aborted = false;
    let nextIndex = 0;
    const MAX_FAILS = 5;
    // Track timings keyed by frame index (= file position) so we can break
    // them down by head/tail quartile to spot HDD seek patterns.
    const frameTimings: { idx: number; ms: number; ts: number }[] = [];
    const extractStart = Date.now();

    const runOne = async (): Promise<void> => {
      while (true) {
        if (aborted) return;
        const idx = nextIndex++;
        if (idx >= count) return;
        const timestamp = idx * interval;
        const outPath = path.join(
          framesDir,
          `frame-${String(idx + 1).padStart(4, '0')}.jpg`,
        );
        const tFrame = Date.now();
        try {
          await this.extractFrameAt(inputPath, timestamp, outPath, crop);
          frameTimings.push({ idx, ms: Date.now() - tFrame, ts: timestamp });
          completed++;
        } catch (err) {
          failed++;
          if (failed <= 3) {
            this.log.warn(
              `Sprite frame ${idx + 1}/${count} @ ${timestamp}s failed for "${label}": ${(err as Error).message}`,
            );
          }
          if (failed >= MAX_FAILS) {
            aborted = true;
            this.log.warn(
              `Sprite aborted for "${label}": ${failed} failures out of ${completed + failed} attempts`,
            );
            return;
          }
        }
        // Emit progress every 4 frames (keep SSE traffic light).
        if ((completed + failed) % 4 === 0 || completed + failed === count) {
          const current = Math.min(
            ((completed + failed) / count) * totalSeconds,
            totalSeconds,
          );
          this.eventsService.emit({
            type: 'task.progress',
            command: progressKey,
            current: Math.round(current),
            total: totalSeconds,
            message: label,
            subject,
          });
          this.activityRegistry.upsertRunning(
            progressKey,
            'GenerateSprite',
            subject,
            Math.round(current),
            totalSeconds,
          );
        }
      }
    };

    const workers = Math.min(FFMPEG_SLOTS, count);
    await Promise.all(Array.from({ length: workers }, () => runOne()));

    const wallMs = Date.now() - extractStart;
    if (frameTimings.length > 0) {
      const sortedByMs = [...frameTimings].sort((a, b) => a.ms - b.ms);
      const msAt = (q: number) =>
        sortedByMs[Math.min(sortedByMs.length - 1, Math.floor(sortedByMs.length * q))].ms;
      const sumMs = sortedByMs.reduce((a, b) => a + b.ms, 0);
      const avg = Math.round(sumMs / sortedByMs.length);
      const fps = (sortedByMs.length / (wallMs / 1000)).toFixed(2);
      // Wall × workers ≈ theoretical max throughput if every worker stayed
      // busy. sumMs / (wall × workers) measures how saturated the worker
      // pool actually was — a low ratio means workers were starved
      // (likely I/O / scheduler contention from `ionice -c3`).
      const saturation = Math.round((sumMs / (wallMs * workers)) * 100);
      // Head vs tail quartile: if extracting from late in the file is
      // markedly slower, the bottleneck is seek I/O (HDD / network mount)
      // rather than decode CPU.
      const byIdx = [...frameTimings].sort((a, b) => a.idx - b.idx);
      const qSize = Math.max(1, Math.ceil(byIdx.length / 4));
      const headAvg = Math.round(
        byIdx.slice(0, qSize).reduce((s, x) => s + x.ms, 0) / qSize,
      );
      const tailAvg = Math.round(
        byIdx.slice(-qSize).reduce((s, x) => s + x.ms, 0) /
          Math.min(qSize, byIdx.length),
      );
      const slowest = sortedByMs[sortedByMs.length - 1];
      this.log.log(
        `Sprite EXTRACT done for "${label}" in ${(wallMs / 1000).toFixed(2)}s — ${sortedByMs.length}/${count} frames @ ${fps} fps (workers=${workers}, sat=${saturation}%, per-frame avg=${avg}ms p50=${msAt(0.5)}ms p95=${msAt(0.95)}ms max=${slowest.ms}ms @${slowest.ts}s, head25%=${headAvg}ms tail25%=${tailAvg}ms${failed > 0 ? `, failed=${failed}` : ''})`,
      );
    }

    if (failed > count * 0.1) {
      throw new Error(
        `Too many frame extractions failed (${failed}/${count}) — sprite would be mostly empty`,
      );
    }

    // A transient seek failure leaves a hole in the frame-NNNN sequence; the
    // image2 tiler stops at the first gap and blanks every later tile. Fill
    // missing indices from the nearest present frame so the tiler reads a
    // contiguous sequence.
    if (failed > 0) await this.backfillMissingFrames(framesDir, count);
  }

  /** Copy the nearest extracted frame into any missing `frame-NNNN.jpg` slot so
   *  the tiler's image2 input stays gap-free. No-op when nothing is missing. */
  private async backfillMissingFrames(
    framesDir: string,
    count: number,
  ): Promise<void> {
    const frameFile = (i: number) =>
      path.join(framesDir, `frame-${String(i).padStart(4, '0')}.jpg`);
    const present = Array.from({ length: count + 1 }, (_, i) =>
      i === 0 ? false : existsSync(frameFile(i)),
    );
    for (let i = 1; i <= count; i++) {
      if (present[i]) continue;
      let src = -1;
      for (let d = 1; d < count && src === -1; d++) {
        if (i - d >= 1 && present[i - d]) src = i - d;
        else if (i + d <= count && present[i + d]) src = i + d;
      }
      if (src === -1) return; // nothing extracted at all
      await fsp.copyFile(frameFile(src), frameFile(i));
      present[i] = true;
    }
  }

  /**
   * Extract a single frame at a specific timestamp via fast keyframe seek.
   * `-ss` BEFORE `-i` uses the demuxer seek (keyframe index) — much faster
   * than accurate seek, with sub-second precision sufficient for thumbnails.
   *
   * The actual ffmpeg argv is built by whichever backend in
   * `./thumbnail-extractors` claims it can handle the crop config (or
   * the lack thereof). See that folder for the per-backend rationale.
   */
  private extractFrameAt(
    inputPath: string,
    seekSeconds: number,
    outputPath: string,
    crop?: CropArea,
  ): Promise<void> {
    return withFfmpegSlot(
      () =>
        new Promise((resolve, reject) => {
          const args = this.chooseExtractor(crop).buildArgs({
            inputPath,
            seekSeconds,
            outputPath,
            crop,
            thumbWidth: THUMB_WIDTH,
          });
          const proc = spawnLowPriority('ffmpeg', args);
          let stderr = '';
          proc.stderr?.on('data', (chunk: Buffer) => {
            if (stderr.length < 4096) stderr += chunk.toString();
          });
          let killed = false;
          const killTimer = setTimeout(() => {
            killed = true;
            try {
              proc.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }, 30_000);
          proc.on('close', (code) => {
            clearTimeout(killTimer);
            if (code === 0) return resolve();
            const reason = killed ? 'timeout (60s)' : `code ${code}`;
            const err = new Error(
              `ffmpeg -ss exited with ${reason}: ${stderr.trim().split('\n').slice(-2).join(' ')}`,
            );
            reject(err);
          });
          proc.on('error', (err) => {
            clearTimeout(killTimer);
            reject(err);
          });
        }),
    );
  }

  /** Tile the extracted individual frames into a single sprite JPEG. */
  private tileSprite(
    framesDir: string,
    spritePath: string,
    rows: number,
  ): Promise<void> {
    return withFfmpegSlot(
      () =>
        new Promise((resolve, reject) => {
          const args = [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-start_number',
            '1',
            '-i',
            path.join(framesDir, 'frame-%04d.jpg'),
            '-vf',
            `tile=${COLUMNS}x${rows}`,
            '-q:v',
            '5',
            '-y',
            spritePath,
          ];
          const proc = spawnLowPriority('ffmpeg', args);
          let stderr = '';
          proc.stderr?.on('data', (chunk: Buffer) => {
            if (stderr.length < 16 * 1024) stderr += chunk.toString();
          });
          let killed = false;
          const killTimer = setTimeout(() => {
            killed = true;
            try {
              proc.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }, 30_000);
          proc.on('close', (code) => {
            clearTimeout(killTimer);
            if (code === 0) return resolve();
            const reason = killed ? 'timeout (30s)' : `code ${code}`;
            const err = new Error(
              `ffmpeg tile exited with ${reason}`,
            ) as Error & { stderr: string };
            err.stderr = stderr;
            reject(err);
          });
          proc.on('error', (err) => {
            clearTimeout(killTimer);
            const e = err as Error & { stderr?: string };
            e.stderr = stderr;
            reject(e);
          });
        }),
    );
  }

  /** Indent every line by 4 spaces — for nicer log formatting. */
  private indent(s: string): string {
    return s
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n');
  }

  private pickInterval(duration: number): number {
    if (duration < 300) return 2;
    if (duration <= 3600) return 5;
    if (duration <= 7200) return 15;
    return 30;
  }
}
