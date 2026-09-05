import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { Media } from '../entities/media.entity';
import { MediaFile } from '../entities/media-file.entity';
import { Season } from '../entities/season.entity';
import { Episode } from '../entities/episode.entity';
import { MediaType } from '../../../common/enums';
import {
  parseReleaseQuality,
  qualityFromResolution,
} from '../../../common/release-parsing';
import { AnalyzeMediaDto } from '../dto/analyze-media.dto';
import { computeMovieHash } from '../../subtitles/moviehash';
import { NamingService } from '../../scheduler/naming.service';
import { FfprobeService } from '../../subtitles/ffprobe.service';
import { SubtitlesService } from '../../subtitles/subtitles.service';
import { EmbeddedSubtitleService } from '../../subtitles/embedded-subtitle.service';
import { SubtitleStreamService } from '../../streaming/subtitle-stream.service';
import {
  ThumbnailService,
  buildSpriteLabel,
} from '../../streaming/thumbnail.service';
import { MediaServersService } from '../../media-servers/media-servers.service';
import { PostImportQueueService } from '../../../common/post-import/post-import-queue.service';
import { MediaMetadataService } from './media-metadata.service';
import { clearMediaCache } from '../../../common/utils/media-cache.util';
import { relativePathUnderMediaRoot } from '../../../common/utils/media-path.util';
import { VIDEO_EXTS } from '../../../common/constants/video-extensions';

type ProbeResult = Awaited<ReturnType<FfprobeService['detectMediaFileInfo']>>;

/** Sync fs on the event loop stalled every other request for the length of a
 *  scan — worse on the network mounts these libraries usually live on. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class MediaRescanService {
  private readonly log = new Logger(MediaRescanService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    private readonly naming: NamingService,
    private readonly ffprobe: FfprobeService,
    private readonly subtitles: SubtitlesService,
    private readonly embeddedSubtitle: EmbeddedSubtitleService,
    private readonly subtitleStream: SubtitleStreamService,
    private readonly thumbnailService: ThumbnailService,
    private readonly mediaServers: MediaServersService,
    private readonly metadata: MediaMetadataService,
    @Inject(forwardRef(() => PostImportQueueService))
    private readonly postImportQueue: PostImportQueueService,
  ) {}

  /**
   * Runs ffprobe on a file already stored in DB (e.g. disk import): streamInfo,
   * crop, resolution-based quality — same path as rescan / download import.
   */
  async enrichMediaFileFromDisk(mediaFileId: number): Promise<void> {
    const dbFile = await this.mediaFileRepo.findOne({
      where: { id: mediaFileId },
      relations: ['media'],
    });
    if (!dbFile?.media?.path) {
      this.log.warn(
        `enrichMediaFileFromDisk: file #${mediaFileId} missing or media has no path`,
      );
      return;
    }
    const mediaDir = path.resolve(dbFile.media.path);
    const normPath = dbFile.relativePath?.replace(/\\/g, '/');
    if (!normPath) return;
    const absPath = path.join(mediaDir, normPath);
    if (!(await pathExists(absPath))) {
      this.log.warn(`enrichMediaFileFromDisk: file not on disk — "${absPath}"`);
      return;
    }

    let diskSize: number;
    try {
      diskSize = (await fsp.stat(absPath)).size;
    } catch (err) {
      this.log.warn(
        `enrichMediaFileFromDisk: cannot stat "${absPath}"`,
        err instanceof Error ? err.stack : err,
      );
      return;
    }

    const filename = path.basename(absPath);

    const streamInfo = await this.probeAndResolve(absPath, filename, {
      detectCrop: false,
      contextLabel: `enrichMediaFileFromDisk[${mediaFileId}]`,
    });
    if (!streamInfo) return;

    dbFile.size = diskSize;
    dbFile.streamInfo = streamInfo.streamInfo;
    // No usable video dimensions: keep the file's existing quality rather than
    // downgrading it to the filename-only 480p fallback.
    if (streamInfo.quality !== null) dbFile.quality = streamInfo.quality;
    const saved = await this.mediaFileRepo.save(dbFile);
    this.log.log(
      `enrichMediaFileFromDisk: enriched media file #${mediaFileId} "${normPath}"`,
    );

    this.postImportQueue.enqueue({ mediaFileId: saved.id });

    void this.mediaServers.dispatch('library.rescan', {
      title: dbFile.media.title,
      path: dbFile.media.path,
    });
  }

  /**
   * Upsert the season + episode rows a series file maps to, returning the
   * episode id (and whether a bare slot was just created). Used by the orphan
   * move/rename path, which needs the episode id to drive the naming format
   * before delegating the file move to the disk-import pipeline.
   */
  async ensureSeriesEpisode(
    media: Media,
    epNums: { season: number; episode: number; episodeEnd?: number | null },
  ): Promise<{ episodeId: number | null; created: boolean }> {
    const { ep, created } = await this.ensureSeasonAndEpisode(
      media,
      epNums,
      media.id,
    );
    return { episodeId: ep?.id ?? null, created };
  }

  /**
   * Register a video file that already lives under `media.path` as a MediaFile
   * row WITHOUT moving it (orphan re-link). Reuses the rescan season/episode
   * upsert and the shared probe/enrich pipeline. Returns the new (or existing)
   * file id, or an `error` string when the file is outside the media folder or
   * a series file has no parsable SxxEyy.
   */
  async linkExistingFileInPlace(p: {
    media: Media;
    absPath: string;
    epNums?: { season: number; episode: number; episodeEnd?: number | null } | null;
  }): Promise<
    | { fileId: number; episodeId: number | null; created: boolean }
    | { error: string }
  > {
    const { media, absPath } = p;
    const relativePath = relativePathUnderMediaRoot(media.path, absPath);
    if (!relativePath) {
      return { error: 'file outside the media folder' };
    }

    const existing = await this.mediaFileRepo.findOne({
      where: { media: { id: media.id }, relativePath },
    });
    if (existing) {
      return {
        fileId: existing.id,
        episodeId: existing.episodeId ?? null,
        created: false,
      };
    }

    const filename = path.basename(absPath);
    let episodeId: number | null = null;
    let created = false;
    if (media.type === MediaType.SERIES) {
      const epNums = p.epNums ?? this.naming.parseEpisodeNumbers(filename, absPath);
      if (!epNums) {
        const special = await this.matchSpecialFile(media.id, absPath);
        if (!special) return { error: 'no SxxEyy pattern found' };
        episodeId = special.id;
      } else {
        const { ep, created: c } = await this.ensureSeasonAndEpisode(
          media,
          epNums,
          media.id,
        );
        episodeId = ep?.id ?? null;
        created = c;
      }
    }

    let size = 0;
    try {
      size = (await fsp.stat(absPath)).size;
    } catch {
      /* keep 0 — enrich re-stats anyway */
    }

    const saved = await this.mediaFileRepo.save(
      this.mediaFileRepo.create({
        media,
        episode: episodeId != null ? ({ id: episodeId } as Episode) : null,
        relativePath,
        size,
        // Provisional from the filename; enrich overwrites from ffprobe.
        quality: parseReleaseQuality(filename).quality.name,
      }),
    );

    // Full probe + crop + osdb + subtitle cache warmup + quality from resolution.
    await this.enrichMediaFileFromDisk(saved.id);

    if (episodeId != null) {
      await this.episodeRepo.update(episodeId, { hasFile: true });
    }

    return { fileId: saved.id, episodeId, created };
  }

  /**
   * Post-probe enrichment shared by every import path (grab→import, disk
   * import, rescan). Runs ffmpeg `cropdetect` and stashes the result into
   * `streamInfo.video[0].crop`, then pre-extracts embedded text subtitles
   * to the player cache (so the first playback doesn't pay the extraction
   * cost — ExoPlayer on Android blocks prepare until every
   * SubtitleConfiguration URL has been fetched).
   *
   * Caller must have already persisted `file.streamInfo` from a fresh
   * ffprobe of `absPath`. Best-effort: failures are logged but don't throw.
   * `streamInfo` is a JSONB blob, so both steps mutate `file` in memory and
   * only this method saves — one write instead of three.
   */
  async finalizeImportedFile(
    file: MediaFile,
    absPath: string,
    media: Media,
  ): Promise<void> {
    await this.detectAndStoreCrop(file, absPath);
    await this.computeAndStoreOsdbHash(file, absPath);
    await this.mediaFileRepo.save(file);
    this.rebuildSubtitleCacheForFile(file, absPath, media);
  }

  /**
   * Compute the OpenSubtitles movie hash and set it on `file` (unsaved) so
   * subsequent subtitle searches can do a hash-based lookup — the central
   * scorer awards near-max credit when the provider confirms a hash match.
   * Best-effort: small or unreadable files leave nulls.
   */
  private async computeAndStoreOsdbHash(
    file: MediaFile,
    absPath: string,
  ): Promise<void> {
    try {
      const result = await computeMovieHash(absPath);
      file.osdbHash = result?.hash ?? null;
      file.osdbBytesize = result?.bytesize ?? null;
    } catch (err) {
      this.log.warn(
        `computeAndStoreOsdbHash: failed for "${absPath}"`,
        err instanceof Error ? err.stack : err,
      );
    }
  }

  /**
   * Re-runs ffmpeg `cropdetect` and sets the result on `file.streamInfo`
   * (unsaved) — caller persists. No-op when the file has no video stream.
   * Best-effort: ffmpeg failures are logged and the row is left unchanged.
   * The crop value is cleared when detection returns nothing so a re-encoded
   * file that lost its letterbox doesn't keep stale crop data.
   */
  private async detectAndStoreCrop(
    file: MediaFile,
    absPath: string,
  ): Promise<void> {
    const streamInfo = file.streamInfo;
    const v = streamInfo?.video?.[0];
    if (!v) return;
    try {
      const crop = await this.ffprobe.detectCrop(
        absPath,
        streamInfo.durationSeconds,
        v.width,
        v.height,
      );
      v.crop = crop ?? undefined;
      file.streamInfo = streamInfo;
    } catch (err) {
      this.log.warn(
        `detectAndStoreCrop: failed for "${absPath}"`,
        err instanceof Error ? err.stack : err,
      );
    }
  }

  /**
   * Fire-and-forget clear + warmup of the embedded-subtitle cache for a file.
   * Whether the warmup actually runs is the admin's `subtitlePrewarm` setting,
   * enforced inside `warmupCache`.
   */
  private rebuildSubtitleCacheForFile(
    file: MediaFile,
    absPath: string,
    media: Media,
  ): void {
    void this.subtitleStream
      .clearMediaFileSubtitleCache(media?.path, file.id)
      .then(() =>
        this.subtitleStream.warmupCache(
          absPath,
          media?.path,
          file.id,
          file.streamInfo?.subtitles,
          media?.title,
        ),
      )
      .catch((err) =>
        this.log.warn(
          `Subtitle cache rebuild failed for file #${file.id}: ${err instanceof Error ? err.message : err}`,
        ),
      );
  }

  /**
   * User-triggered "Analyse" action — iterates the media's files and runs
   * each requested granular operation (cropdetect, embedded-subtitle cache
   * rebuild, forced sprite-sheet regeneration). The full-rescan superset
   * stays on the dedicated `rescanFiles` path so its SSE wiring lives in
   * one place.
   */
  async analyzeMedia(mediaId: number, opts: AnalyzeMediaDto): Promise<void> {
    if (!opts.sprites && !opts.crop && !opts.subtitleCache) return;

    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['files', 'files.episode', 'files.episode.season'],
    });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);
    if (!media.path) {
      throw new BadRequestException(
        `Media #${mediaId} has no root path configured`,
      );
    }

    const mediaDir = path.resolve(media.path);
    const files = media.files ?? [];
    for (const file of files) {
      if (!file.relativePath) continue;
      const absPath = path.join(
        mediaDir,
        file.relativePath.replace(/\\/g, '/'),
      );
      if (!(await pathExists(absPath))) {
        this.log.warn(
          `analyzeMedia[#${mediaId}]: file off-disk, skipping "${absPath}"`,
        );
        continue;
      }
      if (opts.crop) {
        await this.detectAndStoreCrop(file, absPath);
        await this.mediaFileRepo.save(file);
      }
      if (opts.subtitleCache) {
        this.rebuildSubtitleCacheForFile(file, absPath, media);
      }
      if (opts.sprites) {
        const ep = file.episode;
        const label = buildSpriteLabel(
          media,
          ep
            ? {
                seasonNumber: ep.season?.seasonNumber,
                episodeNumber: ep.episodeNumber,
                title: ep.title,
              }
            : null,
        );
        // Background, force=true so the existing sprite/meta gets rebuilt.
        void this.thumbnailService.generateForFile(file, media, label, {
          force: true,
        });
      }
    }
  }

  async rescanFiles(
    mediaId: number,
    options?: { skipWarmup?: boolean },
  ): Promise<{
    added: number;
    removed: number;
    updated: number;
    subtitleRemovedMissing: number;
    subtitleRemovedDuplicates: number;
  }> {
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['files'],
    });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);
    if (!media.path) {
      throw new BadRequestException(
        `Media #${mediaId} has no root path configured`,
      );
    }
    // Set whenever a file forces us to invent a fresh season/episode slot.
    // After the rescan we backfill metadata (titles, stills) for those slots
    // by running the shared series refresh so they don't show up empty.
    let metadataSlotsCreated = false;

    // Wipe the whole per-media `.cache/` tree (subtitles + any other cached
    // artefact) — streamInfo is about to be re-read so anything derived
    // from the old layout is stale.
    try {
      await clearMediaCache(media.path);
    } catch (err) {
      this.log.warn(
        `Rescan[media #${mediaId}]: clearMediaCache failed for "${media.path}": ${err instanceof Error ? err.message : err}`,
      );
    }

    const mediaDir = path.resolve(media.path);
    if (!(await pathExists(mediaDir))) {
      try {
        fs.mkdirSync(mediaDir, { recursive: true });
        this.log.warn(
          `Rescan: created missing media folder — "${mediaDir}" (media #${mediaId} "${media.title}")`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BadRequestException(
          `Cannot create media folder "${mediaDir}": ${msg}`,
        );
      }
    }

    this.log.log(
      `Rescan: started — media #${mediaId} "${media.title}" root="${mediaDir}"`,
    );

    // 1. Collect all video files on disk
    const rawDiskFiles = await this.collectVideoFilesRecursive(
      mediaDir,
      0,
      mediaId,
    );
    const diskFiles: string[] = [];
    const diskRelPaths = new Set<string>();
    for (const f of rawDiskFiles) {
      const rel = relativePathUnderMediaRoot(mediaDir, f);
      if (!rel) {
        this.log.error(
          `Rescan[media #${mediaId}]: file is outside resolved media folder — mediaDir="${mediaDir}" file="${f}"`,
        );
        continue;
      }
      diskRelPaths.add(rel);
      diskFiles.push(f);
    }
    this.log.log(
      `Rescan: found ${diskFiles.length} file(s) on disk, ${(media.files ?? []).length} in DB`,
    );

    // 2. Existing DB records
    const dbFiles = media.files ?? [];
    if (diskFiles.length === 0 && dbFiles.length > 0) {
      this.log.warn(
        `Rescan[media #${mediaId}]: no video file on disk, ${dbFiles.length} file(s) still in DB (orphan rows will be removed if paths do not match)`,
      );
    }
    const dbRelPaths = new Set(
      dbFiles.map((f) => f.relativePath.replace(/\\/g, '/')),
    );

    let added = 0;
    let removed = 0;

    // 3. Remove DB records whose files no longer exist on disk
    for (const dbFile of dbFiles) {
      const normPath = dbFile.relativePath?.replace(/\\/g, '/');
      if (!normPath || !diskRelPaths.has(normPath)) {
        if (normPath?.includes('..')) {
          this.log.error(
            `Rescan[media #${mediaId}]: dropping DB file row with unsafe relativePath (not on disk or invalid): "${normPath}"`,
          );
        }
        const episodeId = dbFile.episodeId;
        try {
          await this.mediaFileRepo.remove(dbFile);
          void this.thumbnailService.deleteForFile(dbFile.id);
          removed++;
          this.log.log(
            `Rescan: removed missing file "${normPath}" for media #${mediaId}`,
          );
          if (episodeId != null) {
            const remaining = await this.mediaFileRepo.count({
              where: { episode: { id: episodeId } },
            });
            if (remaining === 0) {
              await this.episodeRepo.update(episodeId, { hasFile: false });
            }
          }
        } catch (err) {
          this.log.error(
            `Rescan[media #${mediaId}]: failed to remove DB row for missing file "${normPath}"`,
            err instanceof Error ? err.stack : err,
          );
        }
      }
    }

    if (removed > 0) {
      this.log.warn(
        `Rescan[media #${mediaId}]: removed ${removed} file row(s) from DB (not found on disk)`,
      );
    }

    // 4. Refresh metadata for existing DB records from disk
    let updated = 0;
    for (const dbFile of dbFiles) {
      const normPath = dbFile.relativePath?.replace(/\\/g, '/');
      if (!normPath || !diskRelPaths.has(normPath)) continue;
      const absPath = path.join(mediaDir, normPath);

      let diskSize: number;
      try {
        diskSize = (await fsp.stat(absPath)).size;
      } catch (err) {
        this.log.warn(
          `Rescan[media #${mediaId}]: cannot stat file for refresh (skipped) — path="${absPath}" relativePath="${normPath}"`,
          err instanceof Error ? err.stack : err,
        );
        continue;
      }

      const filename = path.basename(absPath);

      // Series files: parse filename, either link a missing episodeId OR
      // patch an existing link with a newly-discovered multi-episode range
      // (e.g. "S07E11-E12.mkv" already imported as E11 gets endEpisodeNumber
      // set retroactively).
      if (media.type === MediaType.SERIES) {
        const epNums = this.naming.parseEpisodeNumbers(filename, absPath);
        if (epNums && dbFile.episodeId == null) {
          try {
            const { ep, created } = await this.ensureSeasonAndEpisode(
              media,
              epNums,
              mediaId,
            );
            if (created) metadataSlotsCreated = true;
            if (ep) {
              dbFile.episode = ep;
              try {
                await this.mediaFileRepo.save(dbFile);
                await this.episodeRepo.update(ep.id, { hasFile: true });
                updated++;
                this.log.log(
                  `Rescan: linked "${normPath}" to S${String(epNums.season).padStart(2, '0')}E${String(epNums.episode).padStart(2, '0')} for media #${mediaId}`,
                );
              } catch (err) {
                this.log.error(
                  `Rescan[media #${mediaId}]: failed to link file "${normPath}" to episode`,
                  err instanceof Error ? err.stack : err,
                );
              }
            }
          } catch (err) {
            this.log.error(
              `Rescan[media #${mediaId}]: failed to create season/episode for refresh "${normPath}"`,
              err instanceof Error ? err.stack : err,
            );
          }
        } else if (!epNums && dbFile.episodeId == null) {
          const special = await this.matchSpecialFile(mediaId, absPath);
          if (special) {
            dbFile.episode = special;
            await this.mediaFileRepo.save(dbFile);
            await this.episodeRepo.update(special.id, { hasFile: true });
            updated++;
          }
        } else if (epNums?.episodeEnd != null && dbFile.episodeId != null) {
          // Already-linked file: retroactively apply the range on its Episode.
          const linked = await this.episodeRepo.findOne({
            where: { id: dbFile.episodeId },
          });
          if (linked && linked.endEpisodeNumber !== epNums.episodeEnd) {
            linked.endEpisodeNumber = epNums.episodeEnd;
            await this.episodeRepo.save(linked);
            this.log.log(
              `Rescan: set endEpisodeNumber=${epNums.episodeEnd} on S${String(epNums.season).padStart(2, '0')}E${String(epNums.episode).padStart(2, '0')} for media #${mediaId}`,
            );
          }
        }
      }

      // Always re-probe streamInfo (fast, ~1s) to pick up schema changes.
      // Skip detectCrop (~5-10s parallel) when the file size hasn't
      // changed — crop is a property of the file, so unchanged bytes
      // mean unchanged crop. Backfilling files that lack crop metadata
      // would otherwise force every rescan of them to do the slow probe
      // again. Operators can force re-detection by deleting the dbFile
      // row or temporarily breaking the size match.
      const sizeUnchanged = dbFile.size === diskSize;
      dbFile.size = diskSize;
      const probed = await this.probeAndResolve(absPath, filename, {
        detectCrop: !sizeUnchanged,
        contextLabel: `Rescan[media #${mediaId}] refresh "${normPath}"`,
      });
      if (!probed) continue;
      let streamInfo = probed.streamInfo;
      if (sizeUnchanged && (dbFile.streamInfo as any)?.video?.[0]?.crop) {
        // Preserve existing crop from previous scan
        if (streamInfo.video[0]) {
          streamInfo.video[0].crop = (dbFile.streamInfo as any).video[0].crop;
        }
      }
      dbFile.streamInfo = streamInfo;
      // No usable video dimensions: keep the existing quality instead of
      // downgrading it to the filename-only 480p fallback.
      if (probed.quality !== null) dbFile.quality = probed.quality;
      try {
        await this.mediaFileRepo.save(dbFile);
        updated++;
        this.log.log(
          `Rescan: refreshed "${normPath}" for media #${mediaId} (size: ${diskSize}, quality: ${probed.quality}${sizeUnchanged ? ', skipped crop' : ''})`,
        );
        if (!options?.skipWarmup) {
          void this.subtitleStream.warmupCache(
            absPath,
            media.path,
            dbFile.id,
            streamInfo?.subtitles,
            media.title,
          );
        }
      } catch (err) {
        this.log.error(
          `Rescan[media #${mediaId}]: failed to save refreshed metadata for "${normPath}"`,
          err instanceof Error ? err.stack : err,
        );
      }
    }

    // 5. Add new files found on disk but not in DB
    for (const absPath of diskFiles) {
      const relativePath = relativePathUnderMediaRoot(mediaDir, absPath);
      if (!relativePath) {
        this.log.error(
          `Rescan[media #${mediaId}]: internal inconsistency — file was listed but not under mediaDir — mediaDir="${mediaDir}" file="${absPath}"`,
        );
        continue;
      }
      if (dbRelPaths.has(relativePath)) continue;

      let size = 0;
      try {
        size = (await fsp.stat(absPath)).size;
      } catch (err) {
        this.log.error(
          `Rescan[media #${mediaId}]: cannot stat new file — path="${absPath}"`,
          err instanceof Error ? err.stack : err,
        );
        continue;
      }

      const filename = path.basename(absPath);

      // Try to match episode for series — create season/episode on the fly if missing
      let episodeId: number | undefined;
      if (media.type === MediaType.SERIES) {
        const epNums = this.naming.parseEpisodeNumbers(filename, absPath);
        if (epNums) {
          try {
            const { ep, created } = await this.ensureSeasonAndEpisode(
              media,
              epNums,
              mediaId,
            );
            if (created) metadataSlotsCreated = true;
            episodeId = ep?.id;
          } catch (err) {
            this.log.error(
              `Rescan[media #${mediaId}]: failed to create season/episode for new file "${filename}" — importing file without episode link`,
              err instanceof Error ? err.stack : err,
            );
          }
        } else {
          const special = await this.matchSpecialFile(mediaId, absPath);
          if (special) {
            episodeId = special.id;
          } else {
            this.log.warn(
              `Rescan[media #${mediaId}]: series file name has no SxxEyy pattern — "${filename}" (skipped, alien file in series folder)`,
            );
            continue;
          }
        }
      }

      const probed = await this.probeAndResolve(absPath, filename, {
        detectCrop: true,
        contextLabel: `Rescan[media #${mediaId}] new file "${relativePath}"`,
      });
      if (!probed) continue;
      // Brand-new row has no prior quality to protect — fall back to the
      // filename-derived guess (source text at the 480p default bucket).
      const quality = probed.quality ?? qualityFromResolution(filename);
      try {
        const savedFile = await this.mediaFileRepo.save(
          this.mediaFileRepo.create({
            media,
            episode: episodeId != null ? ({ id: episodeId } as Episode) : null,
            relativePath,
            size,
            quality,
            streamInfo: probed.streamInfo,
          }),
        );
        added++;
        this.log.log(
          `Rescan: added new file "${relativePath}" for media #${mediaId}`,
        );
        if (episodeId != null) {
          await this.episodeRepo.update(episodeId, { hasFile: true });
        }
        if (!options?.skipWarmup) {
          void this.subtitleStream.warmupCache(
            absPath,
            media.path,
            savedFile.id,
            probed.streamInfo.subtitles,
            media.title,
          );
        }
      } catch (err) {
        this.log.error(
          `Rescan[media #${mediaId}]: failed to save new file row "${relativePath}" abs="${absPath}"`,
          err instanceof Error ? err.stack : err,
        );
      }
    }

    let subtitleRemovedMissing = 0;
    let subtitleRemovedDuplicates = 0;
    try {
      const sub =
        await this.subtitles.reconcileSubtitleFilesAfterRescan(mediaId);
      subtitleRemovedMissing = sub.removedMissing;
      subtitleRemovedDuplicates = sub.removedDuplicates;
      if (subtitleRemovedMissing || subtitleRemovedDuplicates) {
        this.log.log(
          `Rescan: subtitles reconciled — media #${mediaId} removedMissing=${subtitleRemovedMissing} removedDuplicates=${subtitleRemovedDuplicates}`,
        );
      }
      // Discover external subtitle files on disk (filename-based)
      const discovered =
        await this.subtitles.discoverExternalSubtitles(mediaId);
      if (discovered) {
        this.log.log(
          `Rescan: discovered ${discovered} external subtitle(s) on disk for media #${mediaId}`,
        );
      }
      // Always re-detect embedded subtitle streams on rescan: detectAndStore
      // wipes the file's existing embedded rows and recreates them from
      // ffprobe, so deleted tracks disappear and new ones get added even
      // when the file size hasn't changed (e.g. a remux that preserves size).
      const allFiles = await this.mediaFileRepo.find({
        where: { media: { id: mediaId } },
      });
      for (const file of allFiles) {
        try {
          await this.embeddedSubtitle.detectAndStore(
            mediaId,
            file.id,
            file.episodeId ?? undefined,
          );
        } catch (err) {
          this.log.warn(
            `Rescan: embedded subtitle detect failed for file #${file.id} — ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (err) {
      this.log.warn(
        `Rescan: subtitle reconcile/discover failed for media #${mediaId} — ${err instanceof Error ? err.message : err}`,
      );
    }

    this.log.log(
      `Rescan: finished — media #${mediaId} "${media.title}" added=${added} removed=${removed} updated=${updated}`,
    );
    if (added === 0 && removed === 0 && updated === 0) {
      this.log.warn(
        `Rescan[media #${mediaId}]: no changes (added=0 removed=0 updated=0)`,
      );
    }

    if (added || removed || updated) {
      void this.mediaServers.dispatch('library.rescan', {
        title: media.title,
        path: media.path,
      });
    }

    // Slots invented to host newly-discovered files start out as bare rows
    // (episodeNumber + monitored). Run the shared series refresh so they
    // gain titles, overviews, stills and the season poster — the same
    // routine the manual "Refresh metadata" button uses.
    if (metadataSlotsCreated) {
      try {
        await this.metadata.refreshSeriesEpisodes(media);
      } catch (err) {
        this.log.warn(
          `Rescan[media #${mediaId}]: refreshSeriesEpisodes failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      added,
      removed,
      updated,
      subtitleRemovedMissing,
      subtitleRemovedDuplicates,
    };
  }

  /**
   * Upsert season + episode rows for a series file we just discovered on
   * disk (rescan / disk import paths). Returns the resolved episode row, or
   * null if `epNums` was null. Callers wrap with try/catch and log
   * context-specific errors.
   *
   * Retroactively backfills `endEpisodeNumber` on an already-existing
   * episode when the freshly-parsed filename reveals it's a multi-episode
   * file (e.g. "S07E11-E12.mkv" originally indexed as E11 only).
   */
  /**
   * A file that names itself a special but no episode number: match it against the season-0
   * rows by title. Never creates a row — an unplaceable special stays unmatched rather than
   * taking a number, which would attach it to the wrong one.
   */
  private async matchSpecialFile(
    mediaId: number,
    absPath: string,
  ): Promise<Episode | null> {
    const season = await this.seasonRepo.findOne({
      where: { media: { id: mediaId }, seasonNumber: 0 },
      relations: ['episodes'],
    });
    const ep = this.naming.matchSpecialByTitle(
      path.basename(absPath),
      season?.episodes ?? [],
    );
    if (ep) {
      this.log.log(
        `Rescan[media #${mediaId}]: matched special S00E${String(ep.episodeNumber).padStart(2, '0')} ` +
          `"${ep.title ?? ''}" by title — "${path.basename(absPath)}"`,
      );
    }
    return ep;
  }

  private async ensureSeasonAndEpisode(
    media: Media,
    epNums: {
      season: number;
      episode: number;
      episodeEnd?: number | null;
    },
    mediaId: number,
  ): Promise<{ ep: Episode | null; created: boolean }> {
    let created = false;
    let season = await this.seasonRepo.findOne({
      where: { media: { id: media.id }, seasonNumber: epNums.season },
    });
    if (!season) {
      season = await this.seasonRepo.save(
        this.seasonRepo.create({
          media,
          seasonNumber: epNums.season,
          monitored: epNums.season > 0,
        }),
      );
      created = true;
      this.log.log(
        `Rescan: created season ${epNums.season} for media #${mediaId}`,
      );
    }
    let ep = await this.episodeRepo.findOne({
      where: {
        season: { id: season.id },
        episodeNumber: epNums.episode,
      },
    });
    if (!ep) {
      ep = await this.episodeRepo.save(
        this.episodeRepo.create({
          season,
          episodeNumber: epNums.episode,
          endEpisodeNumber: epNums.episodeEnd ?? null,
          monitored: true,
        }),
      );
      created = true;
      this.log.log(
        `Rescan: created episode S${String(epNums.season).padStart(2, '0')}E${String(epNums.episode).padStart(2, '0')} for media #${mediaId}`,
      );
    } else if (
      epNums.episodeEnd != null &&
      ep.endEpisodeNumber !== epNums.episodeEnd
    ) {
      ep.endEpisodeNumber = epNums.episodeEnd;
      await this.episodeRepo.save(ep);
    }
    return { ep, created };
  }

  /**
   * ffprobe + optional cropdetect + filename/resolution quality. Used by
   * every import path (rescan refresh, rescan new file, disk-import enrich)
   * so the probe pipeline lives in one place.
   * Returns null on ffprobe error so callers can `continue`; `quality` is
   * null when there are no usable video dimensions, letting callers decide.
   */
  private async probeAndResolve(
    absPath: string,
    filename: string,
    opts: { detectCrop: boolean; contextLabel: string },
  ): Promise<{ streamInfo: ProbeResult; quality: string | null } | null> {
    let streamInfo: ProbeResult;
    try {
      streamInfo = await this.ffprobe.detectMediaFileInfo(absPath);
    } catch (err) {
      this.log.error(
        `${opts.contextLabel}: ffprobe failed for "${absPath}"`,
        err instanceof Error ? err.stack : err,
      );
      return null;
    }
    if (opts.detectCrop && streamInfo?.video?.[0]) {
      try {
        const v = streamInfo.video[0];
        const crop = await this.ffprobe.detectCrop(
          absPath,
          streamInfo.durationSeconds,
          v.width,
          v.height,
        );
        if (crop) v.crop = crop;
      } catch (err) {
        this.log.warn(
          `${opts.contextLabel}: detectCrop failed (metadata otherwise kept)`,
          err instanceof Error ? err.stack : err,
        );
      }
    }
    const v = streamInfo?.video?.[0];
    const quality =
      v?.width && v?.height
        ? qualityFromResolution(filename, v.width, v.height)
        : null;
    return { streamInfo, quality };
  }

  private async collectVideoFilesRecursive(
    dir: string,
    depth: number,
    mediaId: number,
  ): Promise<string[]> {
    if (depth > 3) {
      this.log.warn(
        `Rescan[media #${mediaId}]: skipping subfolder (max depth 3) — "${dir}"`,
      );
      return [];
    }
    const files: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      this.log.error(
        `Rescan[media #${mediaId}]: cannot read directory (permissions, missing path, or I/O) — "${dir}"`,
        err instanceof Error ? err.stack : err,
      );
      return [];
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(
          ...(await this.collectVideoFilesRecursive(
            fullPath,
            depth + 1,
            mediaId,
          )),
        );
      } else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
    return files;
  }

}
