import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { Readable } from 'stream';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { StreamingService } from './streaming.service';
import { EventsService } from '../scheduler/events.service';
import { Command } from '../scheduler/entities/command.entity';
import { resolveSubtitleAbsolutePath } from '../subtitles/subtitle-path.util';
import { normalizeLanguageCode } from '../../common/constants/app-languages';
import type { SubtitleRenditionMeta } from './transcoding/types';

const execFileAsync = promisify(execFile);

/**
 * Global cap on concurrent warmup extractions — a full library refresh can
 * trigger thousands of warmupCache() calls and we don't want hundreds of
 * ffmpeg processes fighting for disk I/O.
 */
const WARMUP_CONCURRENCY = 2;

interface WarmupTask {
  absolutePath: string;
  mediaRoot: string;
  mediaFileId: number;
  /**
   * All subtitle stream indices to extract in a single FFmpeg invocation.
   * Container scan dominates extraction cost on big mkvs (one 30 GB read
   * per ffmpeg run), so packing N outputs into one process gives a 3-5×
   * speedup vs spawning N processes that each re-scan the same file.
   */
  streamIndices: number[];
  /** Tracks the Command row + remaining task count for this media file. */
  batch: WarmupBatch;
}

interface WarmupBatch {
  cmd: Command | null;
  mediaFileId: number;
  mediaTitle: string;
  total: number;
  remaining: number;
  failed: number;
}

@Injectable()
export class SubtitleStreamService {
  private readonly log = new Logger(SubtitleStreamService.name);
  private readonly warmupQueue: WarmupTask[] = [];
  private warmupRunning = 0;
  /**
   * In-flight extractions keyed by `${mfid}-${streamIndex}`. Lets warmup and
   * a concurrent live stream request share the same FFmpeg invocation — the
   * slower caller just awaits the running promise instead of spawning a
   * second process that would race on the output file.
   */
  private readonly inflight = new Map<string, Promise<void>>();
  /**
   * One batch per mediaFileId. A second warmupCache() call for a file that
   * already has a running batch is silently ignored — otherwise two separate
   * Command rows + progress bars would be created even though `inflight`
   * already dedupes the actual FFmpeg work.
   */
  private readonly activeBatches = new Map<number, WarmupBatch>();

  constructor(
    @InjectRepository(SubtitleFile)
    private readonly subtitleFileRepo: Repository<SubtitleFile>,
    @InjectRepository(Command)
    private readonly commandRepo: Repository<Command>,
    private readonly streamingService: StreamingService,
    private readonly eventsService: EventsService,
  ) {}

  /**
   * Get an external subtitle file converted to WebVTT.
   */
  async getSubtitleAsVtt(subtitleId: number): Promise<string> {
    const sub = await this.subtitleFileRepo.findOne({
      where: { id: subtitleId },
      relations: ['media', 'media.library'],
    });
    if (!sub?.relativePath) {
      throw new NotFoundException(`Subtitle #${subtitleId} not found`);
    }

    const mediaPath = sub.media?.path ?? null;
    const absolute = resolveSubtitleAbsolutePath(mediaPath, sub.relativePath);
    if (!absolute) {
      this.log.error(
        `Subtitle #${subtitleId}: cannot resolve path under media (mediaPath=${mediaPath ?? 'null'}, relativePath="${sub.relativePath}")`,
      );
      throw new NotFoundException(`Subtitle file not found on disk`);
    }

    // Validate the subtitle path resolves to a real location (no traversal via symlinks)
    let realSubPath: string;
    try {
      realSubPath = await fs.realpath(absolute);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log.error(
        `Subtitle #${subtitleId}: file missing or unreadable at resolved path "${absolute}" (stored relativePath="${sub.relativePath}") (${detail})`,
      );
      throw new NotFoundException(`Subtitle file not found on disk`);
    }

    const content = await fs.readFile(realSubPath, 'utf-8');
    const ext = path.extname(realSubPath).toLowerCase();

    if (ext === '.vtt') return content;
    if (ext === '.srt') return this.srtToVtt(content);
    if (ext === '.ass' || ext === '.ssa') return this.assToVtt(content);

    // Fallback: try SRT conversion
    return this.srtToVtt(content);
  }

  /**
   * Text subtitle tracks for the HLS master's `SUBTITLES` rendition group:
   * embedded non-bitmap streams (from cached `streamInfo`) plus external
   * subtitle files on disk. Bitmap subtitles (PGS/DVD/DVB) are excluded —
   * they have no WebVTT form and stay on the burn-in path. Each entry's
   * `key` feeds the existing VTT endpoints (`subtitles/embedded/:idx` for
   * embedded, `subtitles/:id` for external), which the subtitle media
   * playlist references as its single segment.
   */
  async listTextSubtitleRenditions(
    mediaFileId: number,
  ): Promise<SubtitleRenditionMeta[]> {
    const out: SubtitleRenditionMeta[] = [];
    const resolved = await this.streamingService.resolveFile(mediaFileId);
    for (const s of resolved.mediaFile.streamInfo?.subtitles ?? []) {
      if (s.isImageBased) continue;
      out.push({
        kind: 'embedded',
        // Embedded streams carry the raw container tag (often ISO 639-2 like
        // `fre`/`fra`); normalize so the advertised LANGUAGE is the canonical
        // 2-letter code native players match against.
        key: s.streamIndex,
        language: normalizeLanguageCode(s.language),
        name: s.title || s.language || 'Subtitle',
        forced: s.forced,
      });
    }
    // External subtitle files. Query through the relation — `mediaFileId` on
    // SubtitleFile is a @RelationId (virtual), which TypeORM rejects in a
    // `where`. Isolated so a query failure can never drop the embedded subs.
    try {
      const external = await this.subtitleFileRepo.find({
        where: { mediaFile: { id: mediaFileId } },
      });
      for (const sf of external) {
        if (!sf.relativePath) continue;
        out.push({
          kind: 'external',
          key: sf.id,
          language: normalizeLanguageCode(sf.language),
          name: sf.language || 'Subtitle',
          forced: sf.forced,
        });
      }
    } catch (e) {
      this.log.warn(
        `listTextSubtitleRenditions: external query failed for #${mediaFileId}: ${e instanceof Error ? e.message : e}`,
      );
    }
    return out;
  }

  /**
   * Extract an embedded subtitle stream as WebVTT using FFmpeg.
   * Caches the output on disk — subsequent requests stream the cached file
   * instantly, which matters a lot on Android: ExoPlayer pre-fetches every
   * SubtitleConfiguration URL during `prepare()`, so a file with 3-5 embedded
   * subs serialises 3-5 full FFmpeg passes without the cache (15-20s of
   * player-start delay). Warmup is also called at scan time so first-ever
   * playback is already fast.
   */
  async extractEmbeddedSubtitle(
    mediaFileId: number,
    streamIndex: number,
  ): Promise<Readable> {
    if (
      !Number.isInteger(streamIndex) ||
      streamIndex < 0 ||
      streamIndex > 999
    ) {
      throw new BadRequestException(`Invalid stream index: ${streamIndex}`);
    }

    const resolved = await this.streamingService.resolveFile(mediaFileId);
    const mediaRoot = resolved.media.path;
    if (!mediaRoot) {
      throw new NotFoundException(
        `Media file #${mediaFileId} has no media root — cannot cache subtitle`,
      );
    }
    const cachePath = this.cachePathFor(mediaRoot, mediaFileId, streamIndex);
    if (fsSync.existsSync(cachePath)) {
      return fsSync.createReadStream(cachePath);
    }
    // Stream requests bypass the warmup queue and go straight to extraction
    // — a live user shouldn't wait behind hundreds of background warmup tasks
    // queued by a library rescan.
    //
    // ExoPlayer (Android) pre-fetches every SubtitleConfiguration URL during
    // prepare() in parallel, so 5 cache misses would otherwise spawn 5 single
    // ffmpeg processes that each re-scan the same 30 GB container. Instead we
    // batch every uncached text sub of this file into ONE ffmpeg invocation
    // and let the parallel callers join via `inflight`.
    const textSubs =
      resolved.mediaFile.streamInfo?.subtitles?.filter(
        (s) => !s.isImageBased,
      ) ?? [];
    const uncachedIndices = textSubs
      .map((s) => s.streamIndex)
      .filter(
        (idx) =>
          !fsSync.existsSync(this.cachePathFor(mediaRoot, mediaFileId, idx)),
      );

    if (uncachedIndices.length > 1 && uncachedIndices.includes(streamIndex)) {
      await this.extractBatchDeduped(
        resolved.absolutePath,
        mediaRoot,
        mediaFileId,
        uncachedIndices,
      );
    } else {
      await this.extractDeduped(
        resolved.absolutePath,
        mediaRoot,
        mediaFileId,
        streamIndex,
      );
    }
    return fsSync.createReadStream(cachePath);
  }

  /**
   * Pre-extract all non-bitmap embedded subtitles of a media file to disk.
   * Called at import / rescan so the first playback doesn't pay the
   * extraction cost. Skips image-based subs (PGS / VOBSUB / DVB) which
   * need burn-in, not VTT conversion. Fire-and-forget friendly — errors
   * are logged but don't propagate.
   */
  async warmupCache(
    absolutePath: string,
    mediaRoot: string | null | undefined,
    mediaFileId: number,
    subtitles: { streamIndex: number; isImageBased: boolean }[] | undefined,
    mediaTitle?: string,
  ): Promise<void> {
    if (!mediaRoot) return;
    if (!subtitles?.length) return;
    if (this.activeBatches.has(mediaFileId)) {
      this.log.debug?.(
        `warmupCache: batch already running for media file #${mediaFileId}, ignoring duplicate call`,
      );
      return;
    }
    const textSubs = subtitles.filter((s) => !s.isImageBased);
    if (!textSubs.length) return;

    // Skip subs whose cache file is already on disk.
    const pending = textSubs.filter(
      (s) =>
        !fsSync.existsSync(
          this.cachePathFor(mediaRoot, mediaFileId, s.streamIndex),
        ),
    );
    if (!pending.length) return;

    // Track the batch as a Command so the admin task panel shows progress,
    // matching what GenerateSprite does.
    const label = mediaTitle ?? `file #${mediaFileId}`;
    const cmd = await this.commandRepo
      .save(
        this.commandRepo.create({
          name: 'WarmupSubtitles',
          status: 'running',
          trigger: 'system',
          startedOn: new Date(),
          body: { mediaFileId, mediaTitle: label, count: pending.length },
        }),
      )
      .catch((err) => {
        this.log.warn(
          `Could not create WarmupSubtitles command row: ${err instanceof Error ? err.message : err}`,
        );
        return null;
      });
    this.eventsService.emit({
      type: 'command.started',
      name: 'WarmupSubtitles',
    });

    const batch: WarmupBatch = {
      cmd,
      mediaFileId,
      mediaTitle: label,
      total: pending.length,
      remaining: pending.length,
      failed: 0,
    };

    this.activeBatches.set(mediaFileId, batch);
    // One task per file (multi-output ffmpeg) instead of one per stream.
    this.warmupQueue.push({
      absolutePath,
      mediaRoot,
      mediaFileId,
      streamIndices: pending.map((s) => s.streamIndex),
      batch,
    });
    // Emit initial progress=0 so the UI bar appears immediately at queue time,
    // not only after the first extraction finishes.
    this.eventsService.emit({
      type: 'task.progress',
      command: `WarmupSubtitles:${mediaFileId}`,
      current: 0,
      total: pending.length,
      message: label,
    });
    this.log.log(
      `Queued subtitle warmup for "${label}" (${pending.length} stream(s), ` +
        `queue: ${this.warmupQueue.length}, running: ${this.warmupRunning})`,
    );
    this.processWarmupQueue();
  }

  /** Mark a warmup batch as done — fires the command.completed event. */
  private async finalizeBatch(batch: WarmupBatch): Promise<void> {
    const hasFailures = batch.failed > 0;
    const allFailed = hasFailures && batch.failed === batch.total;
    if (batch.cmd) {
      batch.cmd.status = allFailed ? 'failed' : 'completed';
      batch.cmd.endedOn = new Date();
      if (hasFailures) {
        batch.cmd.body = {
          ...batch.cmd.body,
          failed: batch.failed,
        };
      }
      try {
        await this.commandRepo.save(batch.cmd);
      } catch (err) {
        this.log.warn(
          `Could not finalize WarmupSubtitles command: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    // Free the mediaFileId so a later rescan of the same file can warm up again.
    this.activeBatches.delete(batch.mediaFileId);
    this.eventsService.emit({
      type: 'command.completed',
      name: 'WarmupSubtitles',
      status: allFailed ? 'failed' : 'completed',
    });
    this.eventsService.emit({
      type: 'task.progress',
      command: `WarmupSubtitles:${batch.mediaFileId}`,
      current: batch.total,
      total: batch.total,
      message: batch.mediaTitle,
    });
  }

  /**
   * Delete a single media file's subtitle cache subdirectory
   * (`.cache/subs/<mediaFileId>/`) — called when one file is re-probed so
   * the upcoming warmup regenerates its VTTs from the fresh streamInfo.
   * Leaves the rest of `.cache/` (other files, other features) untouched.
   */
  async clearMediaFileSubtitleCache(
    mediaRoot: string | null | undefined,
    mediaFileId: number,
  ): Promise<void> {
    if (!mediaRoot) return;
    const cacheDir = path.join(
      mediaRoot,
      '.cache',
      'subs',
      String(mediaFileId),
    );
    try {
      await fs.rm(cacheDir, { recursive: true, force: true });
    } catch (err) {
      this.log.warn(
        `clearMediaFileSubtitleCache failed for "${cacheDir}": ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private processWarmupQueue(): void {
    while (this.warmupRunning < WARMUP_CONCURRENCY && this.warmupQueue.length) {
      const task = this.warmupQueue.shift()!;
      this.warmupRunning++;
      void this.runWarmupTask(task).finally(() => {
        this.warmupRunning--;
        this.processWarmupQueue();
      });
    }
  }

  /**
   * Run one warmup task — single FFmpeg call extracting every queued stream
   * of a media file in parallel outputs. Falls back to per-stream extraction
   * if the batch fails (one corrupt sub shouldn't kill the others).
   */
  private async runWarmupTask(task: WarmupTask): Promise<void> {
    const { absolutePath, mediaRoot, mediaFileId, streamIndices, batch } = task;

    try {
      await this.extractBatchDeduped(
        absolutePath,
        mediaRoot,
        mediaFileId,
        streamIndices,
      );
      batch.remaining = 0;
    } catch (err) {
      this.log.warn(
        `Batch subtitle extract failed for media file #${mediaFileId}, ` +
          `falling back to per-stream: ${err instanceof Error ? err.message : err}`,
      );
      // Per-stream fallback. extractDeduped honours any in-flight single-stream
      // promise (e.g. from a concurrent live request).
      for (const idx of streamIndices) {
        try {
          await this.extractDeduped(absolutePath, mediaRoot, mediaFileId, idx);
        } catch (e) {
          batch.failed++;
          this.log.warn(
            `Subtitle warmup failed for media file #${mediaFileId} stream ${idx}: ${e instanceof Error ? e.message : e}`,
          );
        }
        batch.remaining = Math.max(0, batch.remaining - 1);
        this.eventsService.emit({
          type: 'task.progress',
          command: `WarmupSubtitles:${mediaFileId}`,
          current: batch.total - batch.remaining,
          total: batch.total,
          message: batch.mediaTitle,
        });
      }
      batch.remaining = 0;
    }

    // Final progress tick (covers the success path which jumped 0 → total
    // in one go) then close the batch.
    this.eventsService.emit({
      type: 'task.progress',
      command: `WarmupSubtitles:${mediaFileId}`,
      current: batch.total,
      total: batch.total,
      message: batch.mediaTitle,
    });
    await this.finalizeBatch(batch);
  }

  private extractDeduped(
    absolutePath: string,
    mediaRoot: string,
    mediaFileId: number,
    streamIndex: number,
  ): Promise<void> {
    const key = `${mediaFileId}-${streamIndex}`;
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;
    // Also re-check the file — it may have been written between the
    // queue push and the actual dequeue.
    if (
      fsSync.existsSync(this.cachePathFor(mediaRoot, mediaFileId, streamIndex))
    ) {
      return Promise.resolve();
    }
    const promise = this.extractToCache(
      absolutePath,
      mediaRoot,
      mediaFileId,
      streamIndex,
    ).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Batched variant: register one shared promise across every requested
   * stream's `inflight` slot so concurrent single-stream callers join the
   * batch instead of racing. Used by both `runWarmupTask` (background) and
   * `extractEmbeddedSubtitle` (live cache miss).
   *
   * Streams that are already in-flight from another batch/single call are
   * skipped — we await the existing promise(s) and, if any indices remain,
   * fire a fresh batch ffmpeg for those alone.
   */
  private async extractBatchDeduped(
    absolutePath: string,
    mediaRoot: string,
    mediaFileId: number,
    streamIndices: number[],
  ): Promise<void> {
    if (!streamIndices.length) return;

    // Partition: subs already in-flight (await them) vs subs we still own.
    const joinPromises: Promise<void>[] = [];
    const ownIndices: number[] = [];
    for (const idx of streamIndices) {
      const key = `${mediaFileId}-${idx}`;
      const existing = this.inflight.get(key);
      if (existing) {
        joinPromises.push(existing);
      } else if (
        fsSync.existsSync(this.cachePathFor(mediaRoot, mediaFileId, idx))
      ) {
        // Already on disk — nothing to do for this index.
      } else {
        ownIndices.push(idx);
      }
    }

    if (!ownIndices.length) {
      // Everything was already covered by an existing inflight or cache.
      await Promise.all(joinPromises);
      return;
    }

    const sharedPromise = this.extractBatchToCache(
      absolutePath,
      mediaRoot,
      mediaFileId,
      ownIndices,
    );
    const ownKeys = ownIndices.map((idx) => `${mediaFileId}-${idx}`);
    for (const key of ownKeys) {
      this.inflight.set(key, sharedPromise);
    }
    void sharedPromise.finally(() => {
      for (const key of ownKeys) {
        if (this.inflight.get(key) === sharedPromise) {
          this.inflight.delete(key);
        }
      }
    });

    await Promise.all([sharedPromise, ...joinPromises]);
  }

  /**
   * Cache path: `<media.path>/.cache/subs/<mediaFileId>/emb-<streamIndex>.vtt`.
   * Living alongside the media means the cache survives server restarts and
   * gets wiped naturally when the user deletes the media folder.
   */
  private cachePathFor(
    mediaRoot: string,
    mediaFileId: number,
    streamIndex: number,
  ): string {
    return path.join(
      mediaRoot,
      '.cache',
      'subs',
      String(mediaFileId),
      `emb-${streamIndex}.vtt`,
    );
  }

  /**
   * Extract every requested subtitle stream of a media file in **one**
   * FFmpeg invocation. Writes each output to `<final>.tmp` first then
   * atomically renames so the cache never holds a partial file. If ANY
   * stream produces an error from FFmpeg the whole batch rejects — caller
   * (`runWarmupTask`) falls back to per-stream extraction.
   */
  private async extractBatchToCache(
    absolutePath: string,
    mediaRoot: string,
    mediaFileId: number,
    streamIndices: number[],
  ): Promise<void> {
    if (!streamIndices.length) return;
    const cacheDir = path.dirname(
      this.cachePathFor(mediaRoot, mediaFileId, streamIndices[0]),
    );
    await fs.mkdir(cacheDir, { recursive: true });

    const outputs = streamIndices.map((idx) => {
      const final = this.cachePathFor(mediaRoot, mediaFileId, idx);
      return { idx, final, tmp: `${final}.tmp` };
    });

    const args: string[] = [
      // Trusted streamInfo populated at import — skip the probe scan.
      '-analyzeduration',
      '0',
      '-probesize',
      '200000',
      '-vn',
      '-an',
      '-i',
      absolutePath,
    ];
    for (const out of outputs) {
      args.push(
        '-map',
        `0:${out.idx}`,
        '-c:s',
        'webvtt',
        '-f',
        'webvtt',
        '-y',
        out.tmp,
      );
    }

    try {
      await new Promise<void>((resolve, reject) => {
        // Low priority — this is a background warmup batch, not a live request.
        const proc =
          process.platform === 'linux'
            ? spawn('ionice', ['-c3', 'nice', '-n19', 'ffmpeg', ...args], {
                stdio: ['ignore', 'ignore', 'pipe'],
              })
            : spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderrTail = '';
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-2000);
        });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `ffmpeg batch subtitle extract failed (${code}): ${stderrTail}`,
              ),
            );
        });
        proc.on('error', reject);
      });

      // All outputs written, promote .tmp → final atomically.
      await Promise.all(
        outputs.map((out) =>
          fs.rename(out.tmp, out.final).catch((err) => {
            this.log.warn(
              `Failed to promote subtitle cache "${out.tmp}" → "${out.final}": ${err instanceof Error ? err.message : err}`,
            );
            throw err;
          }),
        ),
      );
    } catch (err) {
      // Best-effort cleanup of any leftover .tmp files so a retry starts clean.
      await Promise.allSettled(
        outputs.map((out) => fs.rm(out.tmp, { force: true })),
      );
      throw err;
    }
  }

  private async extractToCache(
    absolutePath: string,
    mediaRoot: string,
    mediaFileId: number,
    streamIndex: number,
  ): Promise<void> {
    const cachePath = this.cachePathFor(mediaRoot, mediaFileId, streamIndex);
    const tmpPath = `${cachePath}.tmp`;
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(
          'ffmpeg',
          [
            // Trusted streamInfo populated at import — skip the probe scan.
            '-analyzeduration',
            '0',
            '-probesize',
            '200000',
            // Skip video + audio streams: we only need the subtitle track.
            '-vn',
            '-an',
            '-i',
            absolutePath,
            '-map',
            `0:${streamIndex}`,
            '-c:s',
            'webvtt',
            '-f',
            'webvtt',
            '-y',
            tmpPath,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let stderrTail = '';
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-1000);
        });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `ffmpeg subtitle extract failed (${code}): ${stderrTail}`,
              ),
            );
        });
        proc.on('error', reject);
      });
      await fs.rename(tmpPath, cachePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  private srtToVtt(srt: string): string {
    // Replace SRT timestamp format (00:00:00,000) with VTT format (00:00:00.000)
    const body = srt
      .replace(/\r\n/g, '\n')
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return `WEBVTT\n\n${body}`;
  }

  private assToVtt(ass: string): string {
    const lines: string[] = ['WEBVTT', ''];
    const dialogueRegex =
      /^Dialogue:\s*\d+,(\d+:\d{2}:\d{2}\.\d{2}),(\d+:\d{2}:\d{2}\.\d{2}),([^,]*),([^,]*),\d+,\d+,\d+,([^,]*),(.*)/;

    let cueIndex = 1;
    for (const line of ass.split(/\r?\n/)) {
      const match = dialogueRegex.exec(line);
      if (!match) continue;

      const start = this.assTimeToVtt(match[1]);
      const end = this.assTimeToVtt(match[2]);
      // Strip ASS tags like {\b1}, {\i0}, {\an8}, etc.
      const text = match[6]
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\N/g, '\n')
        .replace(/\\n/g, '\n')
        .trim();

      if (!text) continue;

      lines.push(String(cueIndex++));
      lines.push(`${start} --> ${end}`);
      lines.push(text);
      lines.push('');
    }

    return lines.join('\n');
  }

  private assTimeToVtt(assTime: string): string {
    // ASS: H:MM:SS.CS → VTT: HH:MM:SS.MMS
    const parts = assTime.split(/[:.]/);
    const h = parts[0].padStart(2, '0');
    const m = parts[1];
    const s = parts[2];
    const cs = parts[3];
    return `${h}:${m}:${s}.${cs}0`;
  }
}
