import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { EventsService } from '../scheduler/events.service';
import { Command } from '../scheduler/entities/command.entity';
import { TranscodingService } from './transcoding.service';

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

const BASE_DIR = path.join(process.cwd(), 'images', 'thumbnails');
const FRAMES_TMP_DIR = path.join(process.cwd(), 'images', 'thumbnails-tmp');
/** Concurrent ffmpeg `-ss` seeks per sprite. Saturates the GPU / CPU for
 *  fast extraction while leaving headroom for concurrent streams. */
const SEEK_CONCURRENCY = 8;
/** Frames extracted per ffmpeg invocation. Batching amortizes the ~200ms
 *  HW-accel init overhead across many frames — the dominant cost when
 *  extracting hundreds of thumbnails from a long video. */
const BATCH_SIZE = 32;

/**
 * Build a human-readable label for a sprite: "S01E03 — Episode Title" for a
 * series episode, media title otherwise. Exported so call sites can compute
 * labels upfront (bulk ops) or per-file.
 */
export function buildSpriteLabel(
  media: { title: string },
  episode?: {
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    title?: string | null;
  } | null,
): string {
  if (
    !episode ||
    episode.seasonNumber == null ||
    episode.episodeNumber == null
  ) {
    return media.title;
  }
  const sn = String(episode.seasonNumber).padStart(2, '0');
  const en = String(episode.episodeNumber).padStart(2, '0');
  return `S${sn}E${en} — ${episode.title ?? media.title}`;
}
const COLUMNS = 10;
const THUMB_WIDTH = 240;

/** Max concurrent sprite generations */
const SPRITE_CONCURRENCY = 2;

interface QueueItem {
  mediaFileId: number;
  absolutePath: string;
  durationSeconds: number;
  mediaTitle?: string;
  skipTracking?: boolean;
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
    @Inject(forwardRef(() => TranscodingService))
    private readonly transcodingService: TranscodingService,
  ) {}

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
      streamInfo?: { durationSeconds?: number } | null;
    },
    media: { path: string | null; title: string },
    label: string,
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
      label,
      options.force ?? false,
      options.skipTracking ?? false,
    );
  }

  async getOrGenerate(
    mediaFileId: number,
    absolutePath: string,
    durationSeconds: number,
    mediaTitle?: string,
    force = false,
    skipTracking = false,
  ): Promise<SpriteMetadata | null> {
    const dir = path.join(BASE_DIR, String(mediaFileId));
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

    const promise = new Promise<SpriteMetadata | null>((resolve) => {
      this.queue.push({
        mediaFileId,
        absolutePath,
        durationSeconds,
        mediaTitle,
        skipTracking,
        resolve,
      });
      this.processQueue();
    });

    this.generating.set(mediaFileId, promise);
    promise.finally(() => this.generating.delete(mediaFileId));
    return promise;
  }

  getSpritePath(mediaFileId: number): string {
    return path.join(BASE_DIR, String(mediaFileId), 'sprite.jpg');
  }

  getMetadataPath(mediaFileId: number): string {
    return path.join(BASE_DIR, String(mediaFileId), 'sprite.json');
  }

  /**
   * Read an existing sprite metadata without triggering generation.
   * Used by the streaming endpoints so opening the player doesn't kick off
   * a heavy thumbnail transcode in parallel. Sprite generation is done at
   * import/rescan (scheduler) or via the manual regenerate button.
   */
  async readExistingMeta(mediaFileId: number): Promise<SpriteMetadata | null> {
    const metaPath = path.join(BASE_DIR, String(mediaFileId), 'sprite.json');
    if (!existsSync(metaPath)) return null;
    try {
      return JSON.parse(await fsp.readFile(metaPath, 'utf-8'));
    } catch {
      return null;
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
        item.mediaTitle,
        item.skipTracking,
      )
        .then((meta) => item.resolve(meta))
        .catch((err) => {
          // Don't let unexpected failures stay silent — log stack then
          // resolve null so callers don't hang.
          this.log.error(
            `Sprite generation crashed (file #${item.mediaFileId}, "${item.mediaTitle ?? ''}"): ${(err as Error).message}`,
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
    mediaTitle?: string,
    skipTracking = false,
  ): Promise<SpriteMetadata | null> {
    const dir = path.join(BASE_DIR, String(mediaFileId));
    const spritePath = path.join(dir, 'sprite.jpg');
    const metaPath = path.join(dir, 'sprite.json');
    const interval = this.pickInterval(durationSeconds);
    const count = Math.ceil(durationSeconds / interval);
    const rows = Math.ceil(count / COLUMNS);
    const label = mediaTitle ?? `file #${mediaFileId}`;
    const total = Math.round(durationSeconds);
    const progressKey = `GenerateSprite:${mediaFileId}`;
    const t0 = Date.now();

    this.log.log(
      `Sprite START for "${label}" (file #${mediaFileId}): ${count} thumbs @ ${interval}s interval`,
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

    const framesDir = path.join(FRAMES_TMP_DIR, String(mediaFileId));
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
    });

    // Global 4-minute timeout for the entire sprite (extraction + tiling).
    const SPRITE_TIMEOUT_MS = 4 * 60_000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Sprite generation timed out after 4 minutes`)), SPRITE_TIMEOUT_MS),
    );

    try {
      await Promise.race([
        (async () => {
          // Two-pass via seek: spawn N parallel `ffmpeg -ss` processes (one per
          // thumbnail timestamp) that extract a single frame each — much faster
          // than sequentially decoding the full video. Then tile the frames.
          await this.extractFramesBySeek(
            absolutePath,
            framesDir,
            interval,
            count,
            total,
            label,
            progressKey,
          );

          await this.tileSprite(framesDir, spritePath, rows);
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
      this.log.log(
        `Sprite DONE for "${label}" in ${((Date.now() - t0) / 1000).toFixed(1)}s (${count} thumbs)`,
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
      });
      // Cleanup tmp frames (fire-and-forget).
      fsp
        .rm(path.join(FRAMES_TMP_DIR, String(mediaFileId)), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
    }
  }

  /**
   * Extract thumbnails in batches of up to {@link BATCH_SIZE} frames per
   * ffmpeg invocation. Each worker decodes a contiguous window via
   * `-ss T -t D -vf fps=1/interval`, producing many thumbnails per spawn.
   * This amortizes ffmpeg init + HW-accel setup (~200ms each) across the
   * batch — the dominant cost when a long video needs hundreds of frames.
   */
  private async extractFramesBySeek(
    inputPath: string,
    framesDir: string,
    interval: number,
    count: number,
    totalSeconds: number,
    label: string,
    progressKey: string,
  ): Promise<void> {
    const batchCount = Math.ceil(count / BATCH_SIZE);
    let completed = 0;
    let failed = 0;
    let aborted = false;
    let nextBatchIdx = 0;
    // Abort once a batch-worth of frames has failed — signals a broken file
    // or decoder issue rather than a one-off seek failure.
    const MAX_FAILS = BATCH_SIZE;

    const runOne = async (): Promise<void> => {
      while (true) {
        if (aborted) return;
        const batchIdx = nextBatchIdx++;
        if (batchIdx >= batchCount) return;
        const startIdx = batchIdx * BATCH_SIZE;
        const framesInBatch = Math.min(BATCH_SIZE, count - startIdx);
        const startTs = startIdx * interval;
        try {
          const written = await this.extractBatch(
            inputPath,
            framesDir,
            startTs,
            interval,
            framesInBatch,
            startIdx + 1,
          );
          completed += written;
          failed += framesInBatch - written;
        } catch (err) {
          failed += framesInBatch;
          if (failed <= BATCH_SIZE * 2) {
            this.log.warn(
              `Sprite batch ${batchIdx + 1}/${batchCount} @ ${startTs}s failed for "${label}": ${(err as Error).message}`,
            );
          }
        }
        if (failed >= MAX_FAILS) {
          aborted = true;
          this.log.warn(
            `Sprite aborted for "${label}": ${failed} frame failures out of ${completed + failed} attempts`,
          );
          return;
        }
        this.eventsService.emit({
          type: 'task.progress',
          command: progressKey,
          current: Math.min(
            Math.round(((completed + failed) / count) * totalSeconds),
            totalSeconds,
          ),
          total: totalSeconds,
          message: label,
        });
      }
    };

    const workers = Math.min(SEEK_CONCURRENCY, batchCount);
    await Promise.all(Array.from({ length: workers }, () => runOne()));
    if (failed > count * 0.1) {
      throw new Error(
        `Too many frame extractions failed (${failed}/${count}) — sprite would be mostly empty`,
      );
    }
  }

  /**
   * Extract a batch of consecutive thumbnails in a single ffmpeg process.
   * `-ss` BEFORE `-i` uses fast demuxer seek (nearest prior keyframe);
   * `-t` caps the decode window; `fps=1/interval` samples at the batch
   * cadence; `-start_number` writes global indices so the tile step sees
   * `frame-0001..frame-NNNN.jpg` contiguously across all batches.
   * Returns the number of frames actually written to disk — the tile
   * demuxer stops at the first missing index, so any gap bounds the sprite.
   */
  private extractBatch(
    inputPath: string,
    framesDir: string,
    seekSeconds: number,
    interval: number,
    framesInBatch: number,
    startNumber: number,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      // HW accel for decode — 4K HEVC software decode is slow enough that
      // batching without HW accel can still exceed the per-batch kill timer.
      const hw = this.transcodingService.getDetectedHwAccel();
      const hwArgs: string[] = [];
      if (hw === 'vaapi' || hw === 'qsv') {
        hwArgs.push(
          '-init_hw_device', 'vaapi=va:/dev/dri/renderD128',
          '-hwaccel', 'vaapi',
          '-hwaccel_device', 'va',
          '-hwaccel_output_format', 'nv12',
        );
      } else if (hw === 'nvenc') {
        hwArgs.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'nv12');
      }
      const duration = framesInBatch * interval;
      // `-discard nokey` drops non-keyframe packets at the demuxer, so the
      // decoder only processes I-frames — same keyframe-level behavior as
      // the old per-frame path, just amortized over many thumbnails per
      // ffmpeg spawn. fps filter then samples keyframes at the batch cadence.
      const args = [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-noaccurate_seek',
        '-ss',
        String(seekSeconds),
        '-analyzeduration',
        '0',
        '-probesize',
        '200000',
        '-discard',
        'nokey',
        ...hwArgs,
        '-i',
        inputPath,
        '-t',
        String(duration),
        '-vf',
        `fps=1/${interval},scale=${THUMB_WIDTH}:-1`,
        '-frames:v',
        String(framesInBatch),
        '-q:v',
        '5',
        '-start_number',
        String(startNumber),
        '-y',
        path.join(framesDir, 'frame-%04d.jpg'),
      ];
      const proc = spawnLowPriority('ffmpeg', args);
      let stderr = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString();
      });
      let killed = false;
      // Scale the kill timer with the source duration covered by the batch
      // (≈1.5× realtime wall clock). Min 60s for spawn + seek overhead,
      // max 3 min to stay well under the outer 4-min sprite timeout.
      const killTimeoutMs = Math.min(
        180_000,
        Math.max(60_000, duration * 1_500),
      );
      const killTimer = setTimeout(() => {
        killed = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, killTimeoutMs);
      proc.on('close', async (code) => {
        clearTimeout(killTimer);
        // ffmpeg may return a non-zero code after writing a partial batch
        // (e.g. EOF mid-window). Count what actually landed on disk so the
        // caller can treat partial success as partial success.
        let written = 0;
        for (let i = 0; i < framesInBatch; i++) {
          const p = path.join(
            framesDir,
            `frame-${String(startNumber + i).padStart(4, '0')}.jpg`,
          );
          try {
            await fsp.access(p);
            written++;
          } catch {
            break;
          }
        }
        if (code === 0 || written === framesInBatch) {
          return resolve(written);
        }
        const reason = killed ? `timeout (${killTimeoutMs / 1000}s)` : `code ${code}`;
        reject(new Error(
          `ffmpeg batch exited with ${reason}: ${stderr.trim().split('\n').slice(-2).join(' ')}`,
        ));
      });
      proc.on('error', (err) => {
        clearTimeout(killTimer);
        reject(err);
      });
    });
  }

  /** Tile the extracted individual frames into a single sprite JPEG. */
  private tileSprite(
    framesDir: string,
    spritePath: string,
    rows: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
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
      proc.on('close', (code) => {
        if (code === 0) return resolve();
        const err = new Error(
          `ffmpeg tile exited with code ${code}`,
        ) as Error & { stderr: string };
        err.stderr = stderr;
        reject(err);
      });
      proc.on('error', (err) => {
        const e = err as Error & { stderr?: string };
        e.stderr = stderr;
        reject(e);
      });
    });
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
