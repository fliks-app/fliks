import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Media } from '../../modules/media/entities/media.entity';
import { MediaFile } from '../../modules/media/entities/media-file.entity';
import { Episode } from '../../modules/media/entities/episode.entity';
import { MediaType } from '../enums';
import { relativePathUnderMediaRoot } from '../utils/media-path.util';
import { NamingService } from '../../modules/scheduler/naming.service';
import { SubtitleSchedulerService } from '../../modules/scheduler/subtitle-scheduler.service';
import { MediaService } from '../../modules/media/media.service';
import { FileTransferService, TransferMethod } from '../services/file-transfer.service';

export interface IngestRequest {
  /** Media the file(s) belong to. Must already be anchored to a library
   *  (`library` + `folderName` persisted) — resolving/pinning that is the
   *  caller's job, since each caller picks its own library differently. */
  mediaId: number;
  files: { path: string }[];
  transfer: TransferMethod;
  /** Quality used for naming and the initial `MediaFile.quality` column. */
  fallbackQuality?: string;
  /** For logs / companion-transfer log tags. */
  sourceLabel: string;
  /** Pre-resolved episode for a series file; the caller already matched it. */
  episodeId?: number;
  /** Bypass collision detection and overwrite in place. */
  force?: boolean;
  /** Append " (n)" instead of silently skipping when the computed name collides. */
  uniquifyOnCollision?: boolean;
}

export interface IngestResult {
  imported: MediaFile[];
  seasonNumber?: number;
  episodeNumber?: number;
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
    private readonly naming: NamingService,
    private readonly fileTransfer: FileTransferService,
    @Inject(forwardRef(() => MediaService))
    private readonly mediaService: MediaService,
    @Inject(forwardRef(() => SubtitleSchedulerService))
    private readonly subtitleScheduler: SubtitleSchedulerService,
  ) {}

  async ingest(req: IngestRequest): Promise<IngestResult> {
    const media = await this.mediaRepo.findOne({
      where: { id: req.mediaId },
      relations: ['library'],
    });
    if (!media) {
      throw new Error(`Media #${req.mediaId} not found`);
    }

    const formats = await this.naming.getFormats();
    const companionExts = await this.fileTransfer.getCompanionExts();

    let seasonNumber: number | undefined;
    let episodeNumber: number | undefined;
    let episodeTitle: string | undefined;
    let airDate: string | undefined;
    if (req.episodeId) {
      const ep = await this.episodeRepo.findOne({
        where: { id: req.episodeId },
        relations: ['season'],
      });
      if (ep) {
        episodeNumber = ep.episodeNumber;
        seasonNumber = ep.season?.seasonNumber ?? 1;
        episodeTitle = ep.title ?? undefined;
        airDate = ep.airDate ?? undefined;
      }
    }

    const imported: MediaFile[] = [];

    for (const file of req.files) {
      const ext = path.extname(file.path);
      const sourceBase = path.basename(file.path, ext);
      let newBaseName: string;
      let destDir: string;

      if (media.type === MediaType.MOVIE) {
        newBaseName = this.naming.applyMovieFormat(formats.movie, {
          title: media.title,
          originalTitle: media.originalTitle,
          year: media.year,
          quality: req.fallbackQuality ?? '',
          tmdbId: media.tmdbId,
        });
        destDir = media.path!;
      } else {
        newBaseName = this.naming.applySeriesFormat(formats.series, {
          seriesTitle: media.title,
          season: seasonNumber ?? 1,
          episode: episodeNumber ?? 1,
          episodeTitle,
          quality: req.fallbackQuality ?? '',
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
        throw new Error('destination en dehors du dossier du média');
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
          return sourceSize;
        }
      })();

      // `force` skips the collision check above, so a re-import over an
      // already-tracked path must update that row instead of inserting a dupe.
      const existingFile = await this.fileRepo.findOne({
        where: { media: { id: media.id }, relativePath },
      });
      const saved = existingFile
        ? await this.fileRepo.save(
            Object.assign(existingFile, {
              episode:
                req.episodeId != null
                  ? ({ id: req.episodeId } as Episode)
                  : null,
              size: finalSize,
              quality: req.fallbackQuality ?? '',
            }),
          )
        : await this.fileRepo.save(
            this.fileRepo.create({
              media,
              episode:
                req.episodeId != null
                  ? ({ id: req.episodeId } as Episode)
                  : null,
              relativePath,
              size: finalSize,
              quality: req.fallbackQuality ?? '',
            }),
          );

      try {
        await this.mediaService.enrichMediaFileFromDisk(saved.id);
      } catch (e) {
        this.logger.warn(
          `Ingest[${req.sourceLabel}]: post-import enrichment failed — ${(e as Error).message}`,
        );
      }
      try {
        await this.subtitleScheduler.onMediaFileImported(
          media.id,
          saved.id,
          req.episodeId ?? undefined,
        );
      } catch (e) {
        this.logger.warn(
          `Ingest[${req.sourceLabel}]: post-import subtitle pipeline failed — ${(e as Error).message}`,
        );
      }

      if (req.episodeId) {
        await this.episodeRepo.update(req.episodeId, { hasFile: true });
      }

      imported.push(saved);
    }

    return { imported, seasonNumber, episodeNumber };
  }
}
