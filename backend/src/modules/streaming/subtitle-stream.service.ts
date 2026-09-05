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
import {
  execFile,
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'child_process';
import { promisify } from 'util';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { StreamingService } from './streaming.service';
import { User } from '../users/entities/user.entity';
import { EventsService } from '../scheduler/events.service';
import { ActivityRegistryService } from '../scheduler/activity-registry.service';
import { StreamingSettingsCache } from './streaming-settings-cache.service';
import { Command } from '../scheduler/entities/command.entity';
import { resolveSubtitleAbsolutePath } from '../subtitles/subtitle-path.util';
import { normalizeLanguageCode } from '../../common/constants/app-languages';
import type { SubtitleRenditionMeta } from './transcoding/types';
import { withFfmpegSlot } from '../../common/utils/ffmpeg-slots';
import { getImagesDir } from '../../common/constants/paths';
import {
  formatMediaProgressSubject,
  type MediaProgressSubject,
} from '../../common/utils/media-progress-subject.util';

const execFileAsync = promisify(execFile);

/** getImagesDir() probes the filesystem on its first call — keep this lazy. */
const subsDir = () => path.join(getImagesDir(), 'subs');

/**
 * Global cap on concurrent warmup extractions — a full library refresh can
 * trigger thousands of warmupCache() calls and we don't want hundreds of
 * ffmpeg processes fighting for disk I/O.
 */
const WARMUP_CONCURRENCY = 2;

/** Cap on one extraction. Generous on purpose — the cost is a full container
 *  read (40s for a 22 GB remux on SSD, minutes on a NAS) — but a hung ffmpeg on
 *  a broken file or a dead mount would otherwise hold a warmup slot, and its
 *  `inflight` promise, forever. */
const EXTRACT_TIMEOUT_MS = 15 * 60_000;

interface WarmupTask {
  absolutePath: string;
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
  /** What queued this batch: decides whether it waits on the ffmpeg slot pool. */
  trigger: 'import' | 'playback';
}

interface WarmupBatch {
  cmd: Command | null;
  mediaFileId: number;
  subject: MediaProgressSubject;
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
    private readonly streamingSettings: StreamingSettingsCache,
    private readonly activityRegistry: ActivityRegistryService,
  ) {}

  /** ACL is checked on the subtitle's OWN media, so a foreign id can't be read
   *  via another mediaFileId (IDOR); realpath blocks symlink escapes. */
  private async resolveSubtitleOnDisk(
    subtitleId: number,
    user?: User,
  ): Promise<{ sub: SubtitleFile; realSubPath: string }> {
    const sub = await this.subtitleFileRepo.findOne({
      where: { id: subtitleId },
      relations: ['media', 'media.library', 'mediaFile'],
    });
    await this.streamingService.assertLibraryAccess(
      sub?.media?.libraryId ?? null,
      user,
      `Subtitle #${subtitleId} not found`,
    );
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
    return { sub, realSubPath };
  }

  /** The stored file, named after the copy on disk so its original extension
   *  survives — the player's VTT is a conversion. */
  async getSubtitleFileForDownload(
    subtitleId: number,
    user?: User,
  ): Promise<{ path: string; filename: string }> {
    const { realSubPath } = await this.resolveSubtitleOnDisk(subtitleId, user);
    return { path: realSubPath, filename: path.basename(realSubPath) };
  }

  /**
   * Get an external subtitle file converted to WebVTT.
   */
  async getSubtitleAsVtt(
    subtitleId: number,
    user?: User,
  ): Promise<{ vtt: string; startTimeSeconds: number }> {
    const { sub, realSubPath } = await this.resolveSubtitleOnDisk(
      subtitleId,
      user,
    );

    const content = await fs.readFile(realSubPath, 'utf-8');
    const ext = path.extname(realSubPath).toLowerCase();
    // Sidecar cues are authored 0-based; the player aligns them via the
    // X-TIMESTAMP-MAP offset, which the caller derives from this start PTS.
    const startTimeSeconds =
      sub.mediaFile?.streamInfo?.video?.[0]?.startTimeSeconds ?? 0;
    const vtt =
      ext === '.vtt'
        ? content
        : ext === '.ass' || ext === '.ssa'
          ? this.assToVtt(content)
          : this.srtToVtt(content); // .srt + unknown fallback
    return { vtt, startTimeSeconds };
  }

  /**
   * Text subtitle tracks for the HLS master's `SUBTITLES` group: embedded
   * non-bitmap streams (from cached `streamInfo`) then external files. Bitmap
   * subtitles (PGS/DVD/DVB) are excluded — they have no WebVTT form and stay on
   * the burn-in path. `key` feeds the VTT endpoints (`subtitles/embedded/:idx`,
   * `subtitles/:id`); `name` is a human label (track title / language /
   * "Subtitle") shown by native players (AirPlay, lock-screen). It is NOT a
   * stable id — the master playlist uniquifies colliding names with an
   * increment, and the client no longer matches a track on it.
   */
  async listTextSubtitleRenditions(
    mediaFileId: number,
    user?: User,
  ): Promise<SubtitleRenditionMeta[]> {
    const out: SubtitleRenditionMeta[] = [];
    const resolved = await this.streamingService.resolveFile(mediaFileId, user);
    for (const s of resolved.mediaFile.streamInfo?.subtitles ?? []) {
      if (s.isImageBased) continue;
      out.push({
        kind: 'embedded',
        key: s.streamIndex,
        language: normalizeLanguageCode(s.language),
        name: s.title || normalizeLanguageCode(s.language) || 'Subtitle',
        forced: s.forced,
      });
    }
    // External subtitle files. Query through the relation — `mediaFileId` on
    // SubtitleFile is a @RelationId (virtual), which TypeORM rejects in a
    // `where`. Isolated so a query failure can never drop the embedded subs.
    try {
      const external = await this.subtitleFileRepo.find({
        where: { mediaFile: { id: mediaFileId } },
        // Stable id order so the manifest rendition order (and thus the
        // client's same-language ordinal) is deterministic across requests.
        order: { id: 'ASC' },
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
    user?: User,
  ): Promise<Readable> {
    if (
      !Number.isInteger(streamIndex) ||
      streamIndex < 0 ||
      streamIndex > 999
    ) {
      throw new BadRequestException(`Invalid stream index: ${streamIndex}`);
    }

    const resolved = await this.streamingService.resolveFile(mediaFileId, user);
    const cachePath = this.cachePathFor(mediaFileId, streamIndex);
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
      .filter((idx) => !fsSync.existsSync(this.cachePathFor(mediaFileId, idx)));

    if (uncachedIndices.length > 1 && uncachedIndices.includes(streamIndex)) {
      await this.extractBatchDeduped(
        resolved.absolutePath,
        mediaFileId,
        uncachedIndices,
        false,
      );
    } else {
      await this.extractDeduped(
        resolved.absolutePath,
        mediaFileId,
        streamIndex,
        false,
      );
    }
    return fsSync.createReadStream(cachePath);
  }

  /**
   * Pre-extract all non-bitmap embedded subtitles of a media file to disk, so
   * opening the subtitle menu doesn't pay for a full container read. Skips
   * image-based subs (PGS / VOBSUB / DVB) which need burn-in, not VTT
   * conversion. Fire-and-forget friendly — errors are logged but don't
   * propagate.
   *
   * `trigger` is what caused the call; whether it runs is the admin's
   * `subtitlePrewarm` setting. Gated here rather than at the call sites so the
   * three of them can't drift from it. Nothing depends on this having run: a
   * client asking for an unextracted track gets it extracted then, by the same
   * batched code.
   */
  async warmupCache(
    absolutePath: string,
    mediaFileId: number,
    subtitles: { streamIndex: number; isImageBased: boolean }[] | undefined,
    subject: MediaProgressSubject,
    trigger: 'import' | 'playback' = 'import',
  ): Promise<void> {
    if (!subtitles?.length) return;
    const mode = (await this.streamingSettings.get()).subtitlePrewarm;
    if (mode === 'off' || (mode === 'playback' && trigger === 'import')) return;
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
      (s) => !fsSync.existsSync(this.cachePathFor(mediaFileId, s.streamIndex)),
    );
    if (!pending.length) return;

    // Track the batch as a Command so the admin task panel shows progress,
    // matching what GenerateSprite does.
    const label = formatMediaProgressSubject(subject);
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
      subject,
      total: pending.length,
      remaining: pending.length,
      failed: 0,
    };

    this.activeBatches.set(mediaFileId, batch);
    this.activityRegistry.upsertPending(
      `WarmupSubtitles:${mediaFileId}`,
      'WarmupSubtitles',
      subject,
    );
    // One task per file (multi-output ffmpeg) instead of one per stream.
    this.warmupQueue.push({
      absolutePath,
      mediaFileId,
      streamIndices: pending.map((s) => s.streamIndex),
      batch,
      trigger,
    });
    // Emit initial progress=0 so the UI bar appears immediately at queue time,
    // not only after the first extraction finishes.
    this.eventsService.emit({
      type: 'task.progress',
      command: `WarmupSubtitles:${mediaFileId}`,
      current: 0,
      total: pending.length,
      message: label,
      subject,
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
      message: formatMediaProgressSubject(batch.subject),
      subject: batch.subject,
    });
  }

  /**
   * Delete a single media file's subtitle cache subdirectory — called when a
   * file is re-probed or removed so a later warmup regenerates its VTTs from
   * fresh streamInfo, or so nothing lingers once the file is gone.
   */
  async clearMediaFileSubtitleCache(mediaFileId: number): Promise<void> {
    const cacheDir = this.cacheDirFor(mediaFileId);
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
    const { absolutePath, mediaFileId, streamIndices, batch, trigger } = task;
    // Only an import-time warmup competes for the shared ffmpeg slot pool; a
    // playback-triggered one must extract immediately, same as a live cache miss.
    const background = trigger === 'import';
    const activityId = `WarmupSubtitles:${mediaFileId}`;
    this.activityRegistry.upsertRunning(
      activityId,
      'WarmupSubtitles',
      batch.subject,
      0,
      batch.total,
    );

    try {
      try {
        await this.extractBatchDeduped(
          absolutePath,
          mediaFileId,
          streamIndices,
          background,
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
            await this.extractDeduped(
              absolutePath,
              mediaFileId,
              idx,
              background,
            );
          } catch (e) {
            batch.failed++;
            this.log.warn(
              `Subtitle warmup failed for media file #${mediaFileId} stream ${idx}: ${e instanceof Error ? e.message : e}`,
            );
          }
          batch.remaining = Math.max(0, batch.remaining - 1);
          const current = batch.total - batch.remaining;
          this.eventsService.emit({
            type: 'task.progress',
            command: activityId,
            current,
            total: batch.total,
            message: formatMediaProgressSubject(batch.subject),
            subject: batch.subject,
          });
          this.activityRegistry.upsertRunning(
            activityId,
            'WarmupSubtitles',
            batch.subject,
            current,
            batch.total,
          );
        }
        batch.remaining = 0;
      }
    } finally {
      this.activityRegistry.remove(activityId);
    }

    // Final progress tick (covers the success path which jumped 0 → total
    // in one go) then close the batch.
    this.eventsService.emit({
      type: 'task.progress',
      command: `WarmupSubtitles:${mediaFileId}`,
      current: batch.total,
      total: batch.total,
      message: formatMediaProgressSubject(batch.subject),
      subject: batch.subject,
    });
    await this.finalizeBatch(batch);
  }

  private extractDeduped(
    absolutePath: string,
    mediaFileId: number,
    streamIndex: number,
    background: boolean,
  ): Promise<void> {
    const key = `${mediaFileId}-${streamIndex}`;
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;
    // Also re-check the file — it may have been written between the
    // queue push and the actual dequeue.
    if (fsSync.existsSync(this.cachePathFor(mediaFileId, streamIndex))) {
      return Promise.resolve();
    }
    const promise = this.extractToCache(
      absolutePath,
      mediaFileId,
      streamIndex,
      background,
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
    mediaFileId: number,
    streamIndices: number[],
    background: boolean,
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
      } else if (fsSync.existsSync(this.cachePathFor(mediaFileId, idx))) {
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
      mediaFileId,
      ownIndices,
      background,
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
   * Cache path: `<imagesDir>/subs/<mediaFileId>/emb-<streamIndex>.vtt`. The
   * managed images volume (not the library mount) survives library moves and
   * still works when the library is mounted read-only.
   */
  private cacheDirFor(mediaFileId: number): string {
    return path.join(subsDir(), String(mediaFileId));
  }

  private cachePathFor(mediaFileId: number, streamIndex: number): string {
    return path.join(this.cacheDirFor(mediaFileId), `emb-${streamIndex}.vtt`);
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
    mediaFileId: number,
    streamIndices: number[],
    background: boolean,
  ): Promise<void> {
    if (!streamIndices.length) return;
    await fs.mkdir(this.cacheDirFor(mediaFileId), { recursive: true });

    const outputs = streamIndices.map((idx) => {
      const final = this.cachePathFor(mediaFileId, idx);
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

    const runFfmpeg = () =>
      new Promise<void>((resolve, reject) => {
        const opts: SpawnOptions = {
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: EXTRACT_TIMEOUT_MS,
        };
        // Low priority — this is a background warmup batch, not a live request.
        const proc =
          process.platform === 'linux'
            ? spawn('ionice', ['-c3', 'nice', '-n19', 'ffmpeg', ...args], opts)
            : spawn('ffmpeg', args, opts);
        let stderrTail = '';
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-2000);
        });
        proc.on('close', (code, signal) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                signal
                  ? `ffmpeg batch subtitle extract killed by ${signal} after ${EXTRACT_TIMEOUT_MS / 60_000}min`
                  : `ffmpeg batch subtitle extract failed (${code}): ${stderrTail}`,
              ),
            );
        });
        proc.on('error', reject);
      });

    try {
      // Warmup work waits its turn behind the global budget; a live
      // cache-miss must not queue behind it.
      if (background) await withFfmpegSlot(runFfmpeg);
      else await runFfmpeg();

      // All outputs written, promote .tmp → final atomically.
      await Promise.all(
        outputs.map(async (out) => {
          await this.assertExtracted(out.tmp);
          await fs.rename(out.tmp, out.final).catch((err) => {
            this.log.warn(
              `Failed to promote subtitle cache "${out.tmp}" → "${out.final}": ${err instanceof Error ? err.message : err}`,
            );
            throw err;
          });
        }),
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
    mediaFileId: number,
    streamIndex: number,
    background: boolean,
  ): Promise<void> {
    const cachePath = this.cachePathFor(mediaFileId, streamIndex);
    const tmpPath = `${cachePath}.tmp`;
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const runFfmpeg = () =>
      new Promise<void>((resolve, reject) => {
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
          { stdio: ['ignore', 'ignore', 'pipe'], timeout: EXTRACT_TIMEOUT_MS },
        );
        let stderrTail = '';
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-1000);
        });
        proc.on('close', (code, signal) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                signal
                  ? `ffmpeg subtitle extract killed by ${signal} after ${EXTRACT_TIMEOUT_MS / 60_000}min`
                  : `ffmpeg subtitle extract failed (${code}): ${stderrTail}`,
              ),
            );
        });
        proc.on('error', reject);
      });
    try {
      // Warmup work waits its turn behind the global budget; a live
      // cache-miss must not queue behind it.
      if (background) await withFfmpegSlot(runFfmpeg);
      else await runFfmpeg();
      await this.assertExtracted(tmpPath);
      await fs.rename(tmpPath, cachePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** ffmpeg can exit 0 having written nothing (a mislabelled track, a stream it
   *  could not decode). Promoting that caches an empty track forever, and the
   *  player shows a subtitle that renders nothing. A track with no cues is
   *  legitimate and still carries its WEBVTT header, so only zero bytes is a
   *  failure. */
  private async assertExtracted(tmpPath: string): Promise<void> {
    const { size } = await fs.stat(tmpPath);
    if (size === 0) {
      throw new Error(`ffmpeg wrote an empty subtitle file: "${tmpPath}"`);
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
