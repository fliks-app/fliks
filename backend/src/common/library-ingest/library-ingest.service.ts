import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Media } from '../../modules/media/entities/media.entity';
import { MediaFile } from '../../modules/media/entities/media-file.entity';
import { Episode } from '../../modules/media/entities/episode.entity';
import { Season } from '../../modules/media/entities/season.entity';
import { MediaType } from '../enums';
import { relativePathUnderMediaRoot } from '../utils/media-path.util';
import { NamingService } from '../../modules/scheduler/naming.service';
import { SubtitleSchedulerService } from '../../modules/scheduler/subtitle-scheduler.service';
import { MediaService } from '../../modules/media/media.service';
import { FileTransferService, TransferMethod } from '../services/file-transfer.service';
import { FfprobeService } from '../../modules/subtitles/ffprobe.service';
import { EventsService } from '../../modules/scheduler/events.service';
import { qualityFromResolution } from '../release-parsing';

export interface IngestRequest {
  /** Media the file(s) belong to. Must already be anchored to a library
   *  (`library` + `folderName` persisted) — resolving/pinning that is the
   *  caller's job, since each caller picks its own library differently. */
  mediaId: number;
  /** `episodeId`: pre-resolved by the caller. `size`: last-resort size when
   *  the destination cannot be stat'ed. */
  files: { path: string; episodeId?: number; size?: number }[];
  transfer: TransferMethod;
  /** Quality used when the probe yields no usable dimensions. */
  fallbackQuality?: string;
  /** Release title — source tag of the derived quality and release group. */
  releaseName?: string;
  sourceLabel: string;
  /** Bypass collision detection and overwrite in place. */
  force?: boolean;
  /** Append " (n)" instead of silently skipping when the computed name collides. */
  uniquifyOnCollision?: boolean;
}

export interface IngestResult {
  /** `sourcePath` echoes the request entry, so a caller can map a landed file
   *  back to what it knows about it — a skipped file leaves no entry. */
  imported: {
    file: MediaFile;
    episodeId?: number;
    seasonId?: number;
    sourcePath: string;
  }[];
}

/**
 * Destination-path + filesystem-write + `MediaFile` persistence core shared
 * by every path that lands a file in a library. Extracted from disk import;
 * the media passed in must already be pinned to its library/folderName.
 */
@Injectable()
export class LibraryIngestService {
  private readonly logger = new Logger(LibraryIngestService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly fileRepo: Repository<MediaFile>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    private readonly naming: NamingService,
    private readonly fileTransfer: FileTransferService,
    @Inject(forwardRef(() => MediaService))
    private readonly mediaService: MediaService,
    @Inject(forwardRef(() => SubtitleSchedulerService))
    private readonly subtitleScheduler: SubtitleSchedulerService,
    private readonly ffprobe: FfprobeService,
    private readonly events: EventsService,
  ) {}

  async ingest(req: IngestRequest): Promise<IngestResult> {
    const media = await this.mediaRepo.findOne({
      where: { id: req.mediaId },
      relations: ['library'],
    });
    if (!media) {
      throw new Error(`Media #${req.mediaId} not found`);
    }
    // `media.path` is a getter over library.path + folderName; both are the
    // caller's to set, and a null here would surface as a path.join TypeError.
    if (!media.path) {
      throw new Error(
        `Media #${req.mediaId} is not anchored to a library folder`,
      );
    }
    if (!req.files.length) return { imported: [] };

    // A series release carrying several video files is a season pack: every file
    // is its own episode. Anything else keeps only the largest file (samples,
    // proofs and extras ride along in the same folder). A single-file request is
    // unaffected either way.
    const isSeasonPack = media.type === MediaType.SERIES && req.files.length > 1;
    const files = isSeasonPack
      ? req.files
      : [req.files.reduce((a, b) => ((a.size ?? 0) > (b.size ?? 0) ? a : b))];
    if (isSeasonPack) {
      this.logger.log(
        `Ingest[${req.sourceLabel}]: season pack — ${files.length} episode(s) to import`,
      );
    }

    const formats = await this.naming.getFormats();
    const companionExts = await this.fileTransfer.getCompanionExts();
    const releaseGroup = req.releaseName
      ? this.naming.extractReleaseGroup(req.releaseName)
      : undefined;

    const imported: (IngestResult['imported'][number] & {
      destPath: string;
      seasonNumber?: number;
      episodeNumber?: number;
    })[] = [];

    for (const file of files) {
      const ext = path.extname(file.path);
      const sourceBase = path.basename(file.path, ext);

      let episodeId = file.episodeId;
      let seasonId: number | undefined;
      let seasonNumber: number | undefined;
      let episodeNumber: number | undefined;
      let episodeTitle: string | undefined;
      let airDate: string | undefined;

      if (media.type !== MediaType.MOVIE) {
        const epNums =
          this.naming.parseEpisodeNumbers(sourceBase) ??
          (req.releaseName ? this.naming.parseEpisodeNumbers(req.releaseName) : null);
        seasonNumber = epNums?.season;
        episodeNumber = epNums?.episode;

        if (episodeId != null) {
          // Caller already matched the episode: its row is authoritative.
          const ep = await this.episodeRepo.findOne({
            where: { id: episodeId },
            relations: ['season'],
          });
          if (ep) {
            episodeNumber = ep.episodeNumber;
            seasonNumber = ep.season?.seasonNumber ?? 1;
            seasonId = ep.season?.id;
            episodeTitle = ep.title ?? undefined;
            airDate = ep.airDate ?? undefined;
          }
        } else if (epNums) {
          const season = await this.seasonRepo.findOne({
            where: { media: { id: media.id }, seasonNumber: epNums.season },
          });
          if (season) {
            seasonId = season.id;
            const episode = await this.episodeRepo.findOne({
              where: { season: { id: season.id }, episodeNumber: epNums.episode },
            });
            if (episode) {
              episodeId = episode.id;
              episodeTitle = episode.title ?? undefined;
              airDate = episode.airDate ?? undefined;
              if (
                epNums.episodeEnd != null &&
                episode.endEpisodeNumber !== epNums.episodeEnd
              ) {
                episode.endEpisodeNumber = epNums.episodeEnd;
                await this.episodeRepo.save(episode);
              }
            }
          }
        }
        if (isSeasonPack) {
          this.logger.log(
            `Ingest[${req.sourceLabel}]: "${sourceBase}" → ${epNums ? `S${String(epNums.season).padStart(2, '0')}E${String(epNums.episode).padStart(2, '0')}` : 'no episode parsed'}`,
          );
        }
      }

      // Derive quality from the real pixels, not the (sometimes mislabeled)
      // release name: a torrent tagged "2160p" that is actually 1920×804 must
      // be named + tracked as 1080p. The source tag still comes from the
      // release name. Falls back to the caller's quality when probing yields
      // no dimensions.
      const streamInfo = await this.ffprobe.detectMediaFileInfo(file.path);
      const srcVideo = streamInfo?.video?.[0];
      const quality =
        srcVideo?.width && srcVideo?.height
          ? qualityFromResolution(
              req.releaseName ?? path.basename(file.path),
              srcVideo.width,
              srcVideo.height,
            )
          : (req.fallbackQuality ?? '');

      let newBaseName: string;
      let destDir: string;

      if (media.type === MediaType.MOVIE) {
        newBaseName = this.naming.applyMovieFormat(formats.movie, {
          title: media.title,
          originalTitle: media.originalTitle,
          year: media.year,
          quality,
          releaseGroup,
          tmdbId: media.tmdbId,
        });
        destDir = media.path!;
      } else {
        newBaseName = this.naming.applySeriesFormat(formats.series, {
          seriesTitle: media.title,
          season: seasonNumber ?? 1,
          episode: episodeNumber ?? 1,
          episodeTitle,
          quality,
          releaseGroup,
          airDate,
        });
        const seasonFolder = this.naming.applySeasonFolderFormat(
          formats.seasonFolder,
          { season: seasonNumber ?? 1 },
        );
        destDir = path.join(media.path!, seasonFolder);
      }

      let destPath = path.join(destDir, newBaseName + ext);

      // `relativePath` is stored relative to the MEDIA root (library.path +
      // folderName) — matches how the grab/rescan paths store it.
      let relativePath = relativePathUnderMediaRoot(media.path!, destPath);
      if (!relativePath) {
        this.logger.error(
          `Ingest[${req.sourceLabel}]: computed dest outside media folder — root=${media.path!} dest=${destPath}`,
        );
        continue;
      }

      const collides = async (rel: string, abs: string) =>
        fs.existsSync(abs) ||
        !!(await this.fileRepo.findOne({
          where: { media: { id: media.id }, relativePath: rel },
        }));

      if ((await collides(relativePath, destPath)) && !req.force) {
        if (!req.uniquifyOnCollision) {
          // Re-running the same import is a safe no-op.
          continue;
        }
        // A different file maps to a name already taken by this media (e.g.
        // a second copy of the same quality). Append " (n)" instead of
        // silently skipping it.
        let n = 2;
        let base: string;
        let rel: string | null;
        do {
          base = `${newBaseName} (${n})`;
          destPath = path.join(destDir, base + ext);
          rel = relativePathUnderMediaRoot(media.path!, destPath);
          n++;
        } while (rel && (await collides(rel, destPath)) && n < 100);
        if (!rel) continue;
        newBaseName = base;
        relativePath = rel;
      }

      let sourceSize = 0;
      try {
        sourceSize = fs.statSync(file.path).size;
      } catch {
        // Caller already verified the source exists; best-effort fallback only.
      }

      this.logger.log(
        `Ingest[${req.sourceLabel}]: ${req.transfer} "${path.basename(file.path)}" → "${destPath}"`,
      );
      await this.fileTransfer.transferFile(file.path, destPath, req.transfer);
      await this.fileTransfer.transferCompanions({
        srcDir: path.dirname(file.path),
        destDir,
        sourceBaseName: sourceBase,
        newBaseName,
        method: req.transfer,
        allowedExts: companionExts,
        logTag: `library-ingest:${req.sourceLabel}`,
      });

      const finalSize = (() => {
        try {
          return fs.statSync(destPath).size;
        } catch {
          return file.size ?? sourceSize;
        }
      })();

      const payload = {
        episode: episodeId != null ? ({ id: episodeId } as Episode) : null,
        size: finalSize,
        quality,
        ...(streamInfo ? { streamInfo } : {}),
      };

      // `force` skips the collision check above, so a re-import over an
      // already-tracked path must update that row instead of inserting a dupe.
      const existingFile = await this.fileRepo.findOne({
        where: { media: { id: media.id }, relativePath },
      });
      const saved = existingFile
        ? await this.fileRepo.save(Object.assign(existingFile, payload))
        : await this.fileRepo.save(
            this.fileRepo.create({ media, relativePath, ...payload }),
          );

      if (episodeId != null) {
        await this.episodeRepo.update(episodeId, { hasFile: true });
      }

      imported.push({
        file: saved,
        episodeId,
        seasonId,
        sourcePath: file.path,
        destPath,
        seasonNumber,
        episodeNumber,
      });
    }

    if (imported.length > 0) {
      const single = imported.length === 1 ? imported[0] : undefined;
      this.events.emitDomain({
        type: 'media.files.imported',
        mediaId: media.id,
        ...(single?.seasonNumber != null
          ? { seasonNumber: single.seasonNumber }
          : {}),
        ...(single?.episodeNumber != null
          ? { episodeNumber: single.episodeNumber }
          : {}),
        source: req.releaseName ? 'download' : 'disk',
      });
    }

    // Per-file post-import work: cropdetect + embedded-subtitle cache warmup
    // via finalizeImportedFile, then the external-subtitle search. Sequential
    // to avoid hammering ffmpeg and the subtitle provider rate limits.
    void (async () => {
      for (const { file, episodeId, destPath } of imported) {
        try {
          await this.mediaService.finalizeImportedFile(file, destPath, media);
        } catch (e) {
          this.logger.warn(
            `Ingest[${req.sourceLabel}]: post-import enrichment failed — ${(e as Error).message}`,
          );
        }
        try {
          await this.subtitleScheduler.onMediaFileImported(
            media.id,
            file.id,
            episodeId,
          );
        } catch (e) {
          this.logger.warn(
            `Ingest[${req.sourceLabel}]: post-import subtitle pipeline failed — ${(e as Error).message}`,
          );
        }
      }
    })();

    return {
      imported: imported.map(({ file, episodeId, seasonId, sourcePath }) => ({
        file,
        episodeId,
        seasonId,
        sourcePath,
      })),
    };
  }
}
