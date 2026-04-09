import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { EventsService } from '../scheduler/events.service';
import { Command } from '../scheduler/entities/command.entity';
import { TRANSCODE_DIR } from '../../common/constants/paths';

const execFileAsync = promisify(execFile);

export interface SpriteMetadata {
  interval: number;
  columns: number;
  thumbWidth: number;
  thumbHeight: number;
  count: number;
}

const BASE_DIR = path.join(process.cwd(), 'images', 'thumbnails');
const COLUMNS = 10;
const THUMB_WIDTH = 160;

/** Max concurrent sprite generations */
const SPRITE_CONCURRENCY = 2;

interface QueueItem {
  mediaFileId: number;
  absolutePath: string;
  durationSeconds: number;
  mediaTitle?: string;
  resolve: (meta: SpriteMetadata | null) => void;
}

@Injectable()
export class ThumbnailService {
  private readonly log = new Logger(ThumbnailService.name);
  private readonly generating = new Map<number, Promise<SpriteMetadata | null>>();
  private readonly queue: QueueItem[] = [];
  private running = 0;

  constructor(
    private readonly eventsService: EventsService,
    @InjectRepository(Command)
    private readonly commandRepo: Repository<Command>,
  ) {}

  async getOrGenerate(
    mediaFileId: number,
    absolutePath: string,
    durationSeconds: number,
    mediaTitle?: string,
    force = false,
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
      this.queue.push({ mediaFileId, absolutePath, durationSeconds, mediaTitle, resolve });
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

  private processQueue(): void {
    while (this.running < SPRITE_CONCURRENCY && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.running++;
      this.generate(item.mediaFileId, item.absolutePath, item.durationSeconds, item.mediaTitle)
        .then((meta) => item.resolve(meta))
        .catch(() => item.resolve(null))
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
  ): Promise<SpriteMetadata | null> {
    const dir = path.join(BASE_DIR, String(mediaFileId));
    const framesDir = path.join(TRANSCODE_DIR, 'sprites', String(mediaFileId));
    const spritePath = path.join(dir, 'sprite.jpg');
    const metaPath = path.join(dir, 'sprite.json');
    const interval = this.pickInterval(durationSeconds);
    const count = Math.ceil(durationSeconds / interval);
    const rows = Math.ceil(count / COLUMNS);
    const label = mediaTitle ?? `file #${mediaFileId}`;
    const total = Math.round(durationSeconds);
    const progressKey = `GenerateSprite:${mediaFileId}`;

    this.log.log(
      `Generating sprite for ${label}: ${count} thumbs @ ${interval}s interval...`,
    );

    // Record task in DB
    const cmd = await this.commandRepo.save(
      this.commandRepo.create({
        name: 'GenerateSprite',
        status: 'running',
        trigger: 'system',
        startedOn: new Date(),
        body: { mediaFileId, mediaTitle: label },
      }),
    );
    this.eventsService.emit({ type: 'command.started', name: 'GenerateSprite' });

    await fsp.mkdir(framesDir, { recursive: true });
    await fsp.mkdir(dir, { recursive: true });

    try {
      // Step 1: Extract individual frames (trackable progress)
      await this.extractFrames(absolutePath, framesDir, interval, count, total, label, progressKey);

      // Step 2: Assemble frames into sprite with tile
      await execFileAsync('ffmpeg', [
        '-i', path.join(framesDir, 'frame-%04d.jpg'),
        '-vf', `tile=${COLUMNS}x${rows}`,
        '-q:v', '3',
        '-y',
        spritePath,
      ], { timeout: 60_000 });

      // Read actual dimensions via ffprobe
      let thumbHeight: number;
      try {
        const { stdout } = await execFileAsync('ffprobe', [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=width,height',
          '-of', 'csv=p=0',
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
        `Generated sprite for ${label}: ${count} thumbs @ ${interval}s interval`,
      );

      cmd.status = 'completed';
      cmd.endedOn = new Date();
      await this.commandRepo.save(cmd);
      this.eventsService.emit({ type: 'command.completed', name: 'GenerateSprite', status: 'completed' });

      return meta;
    } catch (err) {
      this.log.warn(`Sprite generation failed for ${label}: ${err.message}`);
      cmd.status = 'failed';
      cmd.endedOn = new Date();
      await this.commandRepo.save(cmd);
      this.eventsService.emit({ type: 'command.completed', name: 'GenerateSprite', status: 'failed' });
      return null;
    } finally {
      // Emit progress completion
      this.eventsService.emit({
        type: 'task.progress',
        command: progressKey,
        current: total,
        total,
        message: label,
      });
      // Clean up individual frames
      fsp.rm(framesDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Extract individual frames and emit progress by counting output files.
   */
  private extractFrames(
    inputPath: string,
    framesDir: string,
    interval: number,
    expectedCount: number,
    totalSeconds: number,
    label: string,
    progressKey: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-i', inputPath,
        '-vf', `fps=1/${interval},scale=${THUMB_WIDTH}:-1`,
        '-q:v', '3',
        '-y',
        path.join(framesDir, 'frame-%04d.jpg'),
      ]);

      // Poll frame count every 3s for progress
      const timer = setInterval(async () => {
        try {
          const files = await fsp.readdir(framesDir);
          const frameCount = files.filter((f) => f.endsWith('.jpg')).length;
          const current = Math.min(frameCount * interval, totalSeconds);
          this.eventsService.emit({
            type: 'task.progress',
            command: progressKey,
            current,
            total: totalSeconds,
            message: label,
          });
        } catch {
          // dir not ready yet
        }
      }, 3000);

      proc.on('close', (code) => {
        clearInterval(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg frame extraction exited with code ${code}`));
      });

      proc.on('error', (err) => {
        clearInterval(timer);
        reject(err);
      });

      // Timeout 10 min
      setTimeout(() => {
        proc.kill('SIGKILL');
        clearInterval(timer);
        reject(new Error('Frame extraction timed out'));
      }, 10 * 60 * 1000);
    });
  }

  private pickInterval(duration: number): number {
    if (duration < 300) return 2;
    if (duration <= 3600) return 5;
    return 10;
  }
}
