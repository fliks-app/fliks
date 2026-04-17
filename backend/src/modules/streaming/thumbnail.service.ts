import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { EventsService } from '../scheduler/events.service';
import { Command } from '../scheduler/entities/command.entity';
import { TranscodingService } from './transcoding.service';

const execFileAsync = promisify(execFile);

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

    try {
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
    progressKey: string,
  ): Promise<void> {
    let completed = 0;
    let failed = 0;
    let consecutiveFails = 0;
    let aborted = false;
    let nextIndex = 0;

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
        try {
          await this.extractFrameAt(inputPath, timestamp, outPath);
          completed++;
          consecutiveFails = 0;
        } catch (err) {
          failed++;
          consecutiveFails++;
          if (consecutiveFails <= 3) {
            this.log.warn(
              `Sprite frame ${idx + 1}/${count} @ ${timestamp}s failed for "${label}": ${(err as Error).message}`,
            );
          }
          if (consecutiveFails >= 3) {
            aborted = true;
            this.log.warn(
              `Sprite aborted for "${label}": ${consecutiveFails} consecutive failures (file missing or unreadable)`,
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
          });
        }
      }
    };

    const workers = Math.min(SEEK_CONCURRENCY, count);
    await Promise.all(Array.from({ length: workers }, () => runOne()));
    if (failed > count * 0.1) {
      throw new Error(
        `Too many frame extractions failed (${failed}/${count}) — sprite would be mostly empty`,
      );
    }
  }

  /**
   * Extract a single frame at a specific timestamp via fast keyframe seek.
   * `-ss` BEFORE `-i` uses the demuxer seek (keyframe index) — much faster
   * than accurate seek, with sub-second precision sufficient for thumbnails.
   */
  private extractFrameAt(
    inputPath: string,
    seekSeconds: number,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // HW accel for decode — 4K HEVC software decode can exceed the 30s
      // kill timer. The init overhead (~200ms) is acceptable now that max
      // concurrent processes is capped at 16 (SEEK_CONCURRENCY × SPRITE_CONCURRENCY).
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
        ...hwArgs,
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${THUMB_WIDTH}:-1`,
        '-q:v',
        '5',
        '-y',
        outputPath,
      ];
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString();
      });
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 30_000);
      proc.on('close', (code) => {
        clearTimeout(killTimer);
        if (code === 0) return resolve();
        const err = new Error(
          `ffmpeg -ss exited with code ${code}: ${stderr.trim().split('\n').slice(-2).join(' ')}`,
        );
        reject(err);
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
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => {
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
    if (duration <= 7200) return 10;
    return 15;
  }
}
