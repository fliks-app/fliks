import {
  Injectable,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { relativePathUnderMediaRoot } from '../../common/utils/media-path.util';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Season } from '../media/entities/season.entity';
import { Episode } from '../media/entities/episode.entity';
import { Library } from '../libraries/entities/library.entity';
import { MediaType } from '../../common/enums';
import { parseReleaseQuality } from '../../common/release-parsing';
import { ImportFileEntry } from './dto/confirm-disk-import.dto';
import { MediaService } from '../media/media.service';
import { NamingService } from '../scheduler/naming.service';
import { SubtitleSchedulerService } from '../scheduler/subtitle-scheduler.service';
import { LibrariesService } from '../libraries/libraries.service';
import {
  FileTransferService,
  TransferMethod,
} from '../../common/services/file-transfer.service';

const VIDEO_EXTS = new Set([
  '.mkv',
  '.mp4',
  '.avi',
  '.mov',
  '.ts',
  '.m2ts',
  '.wmv',
  '.flv',
]);

export interface ScanCandidate {
  filePath: string;
  filename: string;
  size: number;
  qualityName: string;
  qualityId: number;
  seasonNumber: number | null;
  episodeNumber: number | null;
  mediaId: number | null;
  mediaTitle: string | null;
  mediaYear: number | null;
  mediaType: string | null;
  episodeId: number | null;
  episodeTitle: string | null;
  existingQuality: string | null;
}

@Injectable()
export class DiskImportService {
  private readonly logger = new Logger(DiskImportService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly fileRepo: Repository<MediaFile>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @Inject(forwardRef(() => MediaService))
    private readonly mediaService: MediaService,
    @Inject(forwardRef(() => SubtitleSchedulerService))
    private readonly subtitleScheduler: SubtitleSchedulerService,
    private readonly naming: NamingService,
    private readonly libraries: LibrariesService,
    private readonly fileTransfer: FileTransferService,
  ) {}

  async scanFolder(folderPath: string): Promise<ScanCandidate[]> {
    const resolved = path.resolve(folderPath);
    this.logger.log(`Disk library scan started — folder="${resolved}"`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new BadRequestException(
        `Path "${resolved}" does not exist or is not accessible`,
      );
    }
    if (!stat.isDirectory()) {
      throw new BadRequestException(`Path "${resolved}" is not a directory`);
    }

    const videoFiles = this.collectVideoFiles(resolved, 0);
    if (!videoFiles.length) return [];

    const allMedia = await this.mediaRepo.find({
      select: ['id', 'title', 'originalTitle', 'year', 'type'],
    });

    return Promise.all(videoFiles.map((f) => this.buildCandidate(f, allMedia)));
  }

  /**
   * Take user-staged files anywhere on disk and materialise them under the
   * target library's root folder, then register them in DB so the rest of
   * the app sees them as if they had been grabbed by a download client.
   *
   * - The file (and its companions) is either copied or moved depending on
   *   `method`; the source is left intact on copy and unlinked on move.
   * - Destination layout follows the same naming pipeline as the torrent-
   *   completion path (movie folder format, series + season folder format).
   *   `Media.library` / `Media.folderName` are set lazily on the first
   *   imported file for that media; subsequent files reuse them.
   */
  async confirmImport(
    imports: ImportFileEntry[],
    method: TransferMethod,
  ): Promise<{ imported: number; errors: string[] }> {
    let imported = 0;
    const errors: string[] = [];

    const formats = await this.naming.getFormats();
    const companionExts = await this.fileTransfer.getCompanionExts();

    for (const entry of imports) {
      try {
        const media = await this.mediaRepo.findOne({
          where: { id: entry.mediaId },
          relations: ['library'],
        });
        if (!media) {
          errors.push(`Media #${entry.mediaId} not found`);
          continue;
        }

        // Verify the source still exists before we touch the DB.
        let sourceStat: fs.Stats;
        try {
          sourceStat = fs.statSync(entry.filePath);
        } catch {
          errors.push(
            `${path.basename(entry.filePath)}: fichier source introuvable`,
          );
          continue;
        }

        // Resolve target library + its path. Throws if the library has
        // no path configured — surface the message cleanly.
        const library = await this.libraries.requirePathFor(
          entry.targetLibraryId,
        );
        if (!library.mediaTypes?.includes(media.type as MediaType)) {
          errors.push(
            `${path.basename(entry.filePath)}: la bibliothèque "${library.name}" n'accepte pas ${media.type}`,
          );
          continue;
        }

        // Pin the media to this library on the first import. Once assigned
        // we keep the same anchor for subsequent files (a series' S02 must
        // land under the same folder as S01). `Media.path` is a computed
        // getter (library.path + folderName) so we only persist the
        // anchor columns.
        if (!media.libraryId || media.libraryId !== library.id) {
          const folderName =
            media.type === MediaType.MOVIE
              ? this.naming.applyMovieFolderFormat(formats.movieFolder, {
                  title: media.title,
                  originalTitle: media.originalTitle,
                  year: media.year,
                  tmdbId: media.tmdbId,
                })
              : this.naming.applySeriesFolderFormat(formats.seriesFolder, {
                  seriesTitle: media.title,
                  originalTitle: media.originalTitle,
                  year: media.year,
                  tmdbId: media.tmdbId,
                });
          await this.mediaRepo.update(media.id, {
            library: { id: library.id } as Library,
            folderName,
          });
          media.library = library;
          media.folderName = folderName;
        }

        // Build destination filename + folder via the naming service.
        const ext = path.extname(entry.filePath);
        const sourceBase = path.basename(entry.filePath, ext);
        let newBaseName: string;
        let destDir: string;

        if (media.type === MediaType.MOVIE) {
          newBaseName = this.naming.applyMovieFormat(formats.movie, {
            title: media.title,
            originalTitle: media.originalTitle,
            year: media.year,
            quality: entry.quality,
            tmdbId: media.tmdbId,
          });
          destDir = media.path!;
        } else {
          // Series: pull season + episode metadata from the matched Episode
          // (the scan phase already created/linked it) so renaming stays
          // consistent with the DB rather than re-parsing the filename.
          let seasonNumber = 1;
          let episodeNumber = 1;
          let episodeTitle: string | undefined;
          let airDate: string | undefined;
          if (entry.episodeId) {
            const ep = await this.episodeRepo.findOne({
              where: { id: entry.episodeId },
              relations: ['season'],
            });
            if (ep) {
              episodeNumber = ep.episodeNumber;
              seasonNumber = ep.season?.seasonNumber ?? 1;
              episodeTitle = ep.title ?? undefined;
              airDate = ep.airDate ?? undefined;
            }
          }
          newBaseName = this.naming.applySeriesFormat(formats.series, {
            seriesTitle: media.title,
            season: seasonNumber,
            episode: episodeNumber,
            episodeTitle,
            quality: entry.quality,
            airDate,
          });
          const seasonFolder = this.naming.applySeasonFolderFormat(
            formats.seasonFolder,
            { season: seasonNumber },
          );
          destDir = path.join(media.path!, seasonFolder);
        }

        const destPath = path.join(destDir, newBaseName + ext);

        // Skip if the destination already holds a row for this media —
        // re-running the same import twice should be safe / no-op.
        const relativePath = relativePathUnderMediaRoot(
          library.path!,
          destPath,
        );
        if (!relativePath) {
          this.logger.error(
            `Disk import: computed dest outside library root — root=${library.path!} dest=${destPath}`,
          );
          errors.push(
            `${path.basename(entry.filePath)}: destination en dehors du dossier racine`,
          );
          continue;
        }
        const existing = await this.fileRepo.findOne({
          where: { media: { id: media.id }, relativePath },
        });
        if (existing && !entry.force) {
          continue;
        }

        // Filesystem write. mkdir + copy/move handled by FileTransferService.
        await this.fileTransfer.transferFile(entry.filePath, destPath, method);
        await this.fileTransfer.transferCompanions({
          srcDir: path.dirname(entry.filePath),
          destDir,
          sourceBaseName: sourceBase,
          newBaseName,
          method,
          allowedExts: companionExts,
          logTag: `disk-import:${media.title}`,
        });

        const finalSize = (() => {
          try {
            return fs.statSync(destPath).size;
          } catch {
            return sourceStat.size;
          }
        })();

        const saved = await this.fileRepo.save(
          this.fileRepo.create({
            media,
            episode:
              entry.episodeId != null
                ? ({ id: entry.episodeId } as Episode)
                : null,
            relativePath,
            size: finalSize,
            quality: entry.quality,
          }),
        );

        await this.mediaService.enrichMediaFileFromDisk(saved.id);
        try {
          await this.subtitleScheduler.onMediaFileImported(
            media.id,
            saved.id,
            entry.episodeId ?? undefined,
          );
        } catch (e) {
          this.logger.warn(
            `Disk import: post-import subtitle pipeline failed — ${(e as Error).message}`,
          );
        }

        if (entry.episodeId) {
          await this.episodeRepo.update(entry.episodeId, { hasFile: true });
        }

        imported++;
      } catch (e) {
        errors.push(
          `${path.basename(entry.filePath)}: ${(e as Error).message}`,
        );
      }
    }

    return { imported, errors };
  }

  // ---------------------------------------------------------------------------

  private collectVideoFiles(dir: string, depth: number): string[] {
    if (depth > 3) return [];
    const files: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.collectVideoFiles(fullPath, depth + 1));
      } else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
    return files;
  }

  private async buildCandidate(
    filePath: string,
    allMedia: Pick<Media, 'id' | 'title' | 'originalTitle' | 'year' | 'type'>[],
  ): Promise<ScanCandidate> {
    const filename = path.basename(filePath);
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      /* ignore */
    }

    const { quality } = parseReleaseQuality(filename);
    const epNums = this.naming.parseEpisodeNumbers(filename);
    const extractedTitle = this.extractTitle(filename);
    const matched = this.matchMedia(extractedTitle, allMedia);

    let episodeId: number | null = null;
    let episodeTitle: string | null = null;

    if (matched?.type === 'series' && epNums) {
      let season = await this.seasonRepo.findOne({
        where: { media: { id: matched.id }, seasonNumber: epNums.season },
      });
      if (!season) {
        season = await this.seasonRepo.save(
          this.seasonRepo.create({
            media: { id: matched.id } as Media,
            seasonNumber: epNums.season,
            monitored: true,
          }),
        );
      }
      let ep = await this.episodeRepo.findOne({
        where: { season: { id: season.id }, episodeNumber: epNums.episode },
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
      } else if (
        epNums.episodeEnd != null &&
        ep.endEpisodeNumber !== epNums.episodeEnd
      ) {
        ep.endEpisodeNumber = epNums.episodeEnd;
        await this.episodeRepo.save(ep);
      }
      episodeId = ep.id;
      episodeTitle = ep.title ?? null;
    }

    return {
      filePath,
      filename,
      size,
      qualityName: quality.name,
      qualityId: quality.id,
      seasonNumber: epNums?.season ?? null,
      episodeNumber: epNums?.episode ?? null,
      mediaId: matched?.id ?? null,
      mediaTitle: matched?.title ?? null,
      mediaYear: matched?.year ?? null,
      mediaType: matched?.type ?? null,
      episodeId,
      episodeTitle,
      existingQuality: null,
    };
  }

  private extractTitle(filename: string): string {
    let name = path.basename(filename, path.extname(filename));
    name = name.replace(/[._]/g, ' ');
    // Cut off at quality markers or episode pattern
    name = name.replace(/\s*\b(2160|4k|uhd|1080|720|480p?)\b.*/i, '');
    name = name.replace(
      /\s*\b(bluray|blu.?ray|web.?dl|web.?rip|hdtv|dvdrip|bdrip|remux)\b.*/i,
      '',
    );
    name = name.replace(/\s*\b(x264|x265|xvid|h264|h265|hevc|avc)\b.*/i, '');
    name = name.replace(/\s*[Ss]\d{1,2}[Ee]\d{1,3}.*/i, '');
    // Remove trailing year
    name = name.replace(/\s*[\[(]?\d{4}[\])]?\s*$/, '');
    return name.trim().toLowerCase();
  }

  private matchMedia(
    extractedTitle: string,
    allMedia: Pick<Media, 'id' | 'title' | 'originalTitle' | 'year' | 'type'>[],
  ): Pick<Media, 'id' | 'title' | 'originalTitle' | 'year' | 'type'> | null {
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const target = norm(extractedTitle);
    if (!target) return null;

    // Exact match
    let match = allMedia.find(
      (m) => norm(m.title) === target || norm(m.originalTitle ?? '') === target,
    );
    if (match) return match;

    // Target starts with media title (e.g. "inception 2010" -> "inception")
    match = allMedia.find((m) => {
      const mt = norm(m.title);
      return mt.length >= 2 && target.startsWith(mt);
    });
    if (match) return match;

    // Media title starts with target
    match = allMedia.find((m) => {
      const mt = norm(m.title);
      return mt.length >= 3 && mt.startsWith(target);
    });
    return match ?? null;
  }
}
