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
import { sanitizeFsPath } from '../../common/utils/fs-path.util';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Season } from '../media/entities/season.entity';
import { Episode } from '../media/entities/episode.entity';
import { Library } from '../libraries/entities/library.entity';
import { MediaType } from '../../common/enums';
import { parseReleaseQuality, extractMediaTitle } from '../../common/release-parsing';
import { ImportFileEntry } from './dto/confirm-disk-import.dto';
import { RelinkOrphansDto } from './dto/relink-orphans.dto';
import {
  OrphanScanResult,
  OrphanGroup,
  OrphanFileEntry,
  RelinkResult,
} from './dto/orphan-scan.dto';
import { NfoMetadataService } from './nfo-metadata.service';
import { MediaService } from '../media/media.service';
import { MediaMetadataService } from '../media/media-service/media-metadata.service';
import { NamingService } from '../scheduler/naming.service';
import { SubtitleSchedulerService } from '../scheduler/subtitle-scheduler.service';
import { LibrariesService } from '../libraries/libraries.service';
import { TransferMethod } from '../../common/services/file-transfer.service';
import { LibraryIngestService } from '../../common/library-ingest/library-ingest.service';

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
    @Inject(forwardRef(() => MediaMetadataService))
    private readonly metadata: MediaMetadataService,
    private readonly nfo: NfoMetadataService,
    private readonly libraryIngest: LibraryIngestService,
  ) {}

  /**
   * Walk a library's own root folder and surface video files not yet linked
   * to any media in that library (orphans), grouped so each unit can be
   * re-created from TMDB/TVDB and linked in place. Cheap: filename + .nfo
   * hints only, no ffprobe.
   */
  async scanLibraryOrphans(libraryId: number): Promise<OrphanScanResult> {
    const library = await this.libraries.requirePathFor(libraryId);
    const root = path.resolve(library.path!);
    this.logger.log(`Orphan scan started — library #${libraryId} root="${root}"`);

    const allFiles = this.collectVideoFiles(root, 0);

    // Build the set of absolute paths already linked in this library.
    const linkedRows = await this.fileRepo.find({
      where: { media: { library: { id: libraryId } } },
      relations: ['media', 'media.library'],
    });
    const linkedSet = new Set<string>();
    for (const f of linkedRows) {
      const base = f.media?.path ?? library.path!;
      linkedSet.add(
        path.resolve(path.join(base, f.relativePath.replace(/\\/g, '/'))),
      );
    }

    const suggestedProvider = library.preferredProvider ?? 'tmdb';
    const groups = new Map<string, OrphanGroup>();
    const looseFiles: OrphanFileEntry[] = [];
    let orphanCount = 0;

    for (const abs of allFiles) {
      if (linkedSet.has(path.resolve(abs))) continue;

      const filename = path.basename(abs);
      const epNums = this.naming.parseEpisodeNumbers(filename);
      // Skip files whose inferred type the library doesn't accept (e.g. a
      // series file under a movies-only library) — they can't be re-linked here.
      const inferredType = epNums ? MediaType.SERIES : MediaType.MOVIE;
      if (!library.mediaTypes?.includes(inferredType)) continue;
      orphanCount++;

      const { quality } = parseReleaseQuality(filename);
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        /* ignore */
      }
      const entry: OrphanFileEntry = {
        filePath: abs,
        filename,
        size,
        qualityName: quality.name,
        qualityId: quality.id,
        seasonNumber: epNums?.season ?? null,
        episodeNumber: epNums?.episode ?? null,
        episodeEnd: epNums?.episodeEnd ?? null,
      };

      const rel = relativePathUnderMediaRoot(root, abs);
      const segments = rel ? rel.split('/') : [];
      // A file directly at the library root has a single segment (its name).
      const folderName = segments.length > 1 ? segments[0] : '';
      if (!folderName) {
        looseFiles.push(entry);
        continue;
      }

      if (epNums) {
        // Series: one group per show folder.
        const key = `series:${folderName}`;
        let group = groups.get(key);
        if (!group) {
          const extracted = extractMediaTitle(filename);
          const nfo = await this.nfo.readForVideoFile(abs);
          group = {
            groupKey: key,
            mediaType: MediaType.SERIES,
            folderName,
            guessTitle: nfo?.title ?? extracted.title ?? folderName,
            guessYear: nfo?.year ?? extracted.year ?? null,
            nfo,
            suggestedProvider,
            files: [],
          };
          groups.set(key, group);
        }
        group.files.push(entry);
      } else {
        // Movie: one group per file.
        const extracted = extractMediaTitle(filename);
        const nfo = await this.nfo.readForVideoFile(abs);
        groups.set(`movie:${abs}`, {
          groupKey: `movie:${abs}`,
          mediaType: MediaType.MOVIE,
          folderName,
          guessTitle: nfo?.title ?? extracted.title ?? folderName,
          guessYear: nfo?.year ?? extracted.year ?? null,
          nfo,
          suggestedProvider,
          files: [entry],
        });
      }
    }

    this.logger.log(
      `Orphan scan finished — library #${libraryId} scanned=${allFiles.length} orphans=${orphanCount} groups=${groups.size} loose=${looseFiles.length}`,
    );
    return {
      libraryId,
      libraryPath: library.path!,
      groups: [...groups.values()],
      looseFiles,
      scannedFiles: allFiles.length,
      orphanCount,
    };
  }

  /**
   * Re-create a media from the chosen TMDB/TVDB match and link the orphan
   * file(s) to it IN PLACE (no move). Reuses an existing media when the
   * external id is already present.
   */
  async relinkOrphans(
    dto: RelinkOrphansDto,
    addedByUserId: number | null,
  ): Promise<RelinkResult> {
    const library = await this.libraries.requirePathFor(dto.libraryId);
    if (!library.mediaTypes?.includes(dto.type)) {
      throw new BadRequestException(
        `La bibliothèque "${library.name}" n'accepte pas ${dto.type}`,
      );
    }

    const externalIdNum = Number(dto.externalId);
    const where =
      dto.provider === 'tvdb'
        ? { tvdbId: externalIdNum, type: dto.type }
        : { tmdbId: externalIdNum, type: dto.type };

    let media = await this.mediaRepo.findOne({
      where,
      relations: ['library', 'files'],
    });
    let created = false;
    if (!media) {
      try {
        const imported = await this.mediaService.importMedia(
          {
            type: dto.type,
            externalId: dto.externalId,
            provider: dto.provider,
            libraryId: dto.libraryId,
            qualityProfileId: dto.qualityProfileId,
            languageProfileId: dto.languageProfileId,
          },
          addedByUserId,
        );
        media = await this.mediaRepo.findOne({
          where: { id: imported.id },
          relations: ['library', 'files'],
        });
        created = true;
      } catch (e) {
        // Two orphan files of the same title (e.g. multiple editions, or the
        // auto-import linking siblings in parallel) can both reach the create
        // branch before either insert lands, tripping the unique (type,tmdbId)
        // constraint. Re-fetch and reuse the row the other request created.
        media = await this.mediaRepo.findOne({
          where,
          relations: ['library', 'files'],
        });
        if (!media) throw e;
      }
    }
    if (!media) {
      throw new BadRequestException('Média introuvable après import');
    }
    if (media.library && media.library.id !== dto.libraryId) {
      throw new BadRequestException(
        `Ce média est déjà rattaché à une autre bibliothèque ("${media.library.name}")`,
      );
    }

    let linked = 0;
    let slotCreated = false;
    const errors: string[] = [];

    if (dto.reorganize) {
      // Move + rename into the library's naming layout by delegating to the
      // existing disk-import pipeline (handles folder/file naming, companions,
      // MediaFile creation, ffprobe enrich and subtitle scheduling).
      if (!media.library) media.library = library;
      const entries: ImportFileEntry[] = [];
      for (const f of dto.files) {
        const filename = path.basename(f.filePath);
        let episodeId: number | undefined;
        if (media.type === MediaType.SERIES) {
          const epNums =
            f.seasonNumber != null && f.episodeNumber != null
              ? {
                  season: f.seasonNumber,
                  episode: f.episodeNumber,
                  episodeEnd: f.episodeEnd ?? null,
                }
              : this.naming.parseEpisodeNumbers(filename);
          if (!epNums) {
            errors.push(`${filename}: aucun motif SxxEyy détecté`);
            continue;
          }
          const ep = await this.mediaService.ensureSeriesEpisode(media, epNums);
          episodeId = ep.episodeId ?? undefined;
          slotCreated ||= ep.created;
        }
        entries.push({
          filePath: f.filePath,
          mediaId: media.id,
          episodeId,
          quality: parseReleaseQuality(filename).quality.name,
          targetLibraryId: dto.libraryId,
        });
      }
      if (entries.length) {
        const res = await this.confirmImport(entries, 'move', {
          uniquifyOnCollision: true,
        });
        linked = res.imported;
        errors.push(...res.errors);
      }
    } else {
      // Link in place — pin the media to the orphan's on-disk folder so
      // `relativePath` stays valid, but only when it has no files yet.
      if (
        (media.files?.length ?? 0) === 0 &&
        media.folderName !== dto.folderName
      ) {
        await this.mediaRepo.update(media.id, {
          library: { id: library.id } as Library,
          folderName: dto.folderName,
        });
        media.folderName = dto.folderName;
      }
      if (!media.library) media.library = library;

      for (const f of dto.files) {
        const absPath = path.resolve(f.filePath);
        const epNums =
          f.seasonNumber != null && f.episodeNumber != null
            ? {
                season: f.seasonNumber,
                episode: f.episodeNumber,
                episodeEnd: f.episodeEnd ?? null,
              }
            : undefined;
        const res = await this.mediaService.linkExistingFileInPlace({
          media,
          absPath,
          epNums,
        });
        if ('error' in res) {
          errors.push(`${path.basename(f.filePath)}: ${res.error}`);
          continue;
        }
        linked++;
        slotCreated ||= res.created;
        try {
          await this.subtitleScheduler.onMediaFileImported(
            media.id,
            res.fileId,
            res.episodeId ?? undefined,
          );
        } catch (e) {
          this.logger.warn(
            `Orphan relink: post-link subtitle pipeline failed — ${(e as Error).message}`,
          );
        }
      }
    }

    // Backfill metadata for any season/episode slot invented while linking.
    if (media.type === MediaType.SERIES && slotCreated) {
      try {
        await this.metadata.refreshSeriesEpisodes(media);
      } catch (e) {
        this.logger.warn(
          `Orphan relink: refreshSeriesEpisodes failed — ${(e as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Orphan relink — media #${media.id} created=${created} linked=${linked} errors=${errors.length}`,
    );
    return { mediaId: media.id, created, linked, errors };
  }

  async scanFolder(folderPath: string): Promise<ScanCandidate[]> {
    const resolved = path.resolve(sanitizeFsPath(folderPath));
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

    // `buildCandidate` may invent a fresh season / episode slot for any file
    // that references one we haven't pulled metadata for yet. Collect the
    // owning media so we can backfill those rows (titles, overviews, stills)
    // via the shared series refresh, instead of leaving them bare in the UI.
    const dirty = new Set<number>();
    const candidates = await Promise.all(
      videoFiles.map((f) => this.buildCandidate(f, allMedia, dirty)),
    );
    for (const mediaId of dirty) {
      try {
        const media = await this.mediaRepo.findOne({ where: { id: mediaId } });
        if (media && media.type === MediaType.SERIES) {
          await this.metadata.refreshSeriesEpisodes(media);
        }
      } catch (err) {
        this.logger.warn(
          `Disk scan: refreshSeriesEpisodes #${mediaId} failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return candidates;
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
    opts: { uniquifyOnCollision?: boolean } = {},
  ): Promise<{ imported: number; errors: string[] }> {
    let imported = 0;
    const errors: string[] = [];

    const formats = await this.naming.getFormats();

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
        try {
          fs.statSync(entry.filePath);
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

        // Destination path, filesystem write, MediaFile row and post-import
        // enrichment all live in the shared ingest service.
        const result = await this.libraryIngest.ingest({
          mediaId: media.id,
          files: [{ path: entry.filePath }],
          transfer: method,
          fallbackQuality: entry.quality,
          sourceLabel: media.title,
          episodeId: entry.episodeId,
          force: entry.force,
          uniquifyOnCollision: opts.uniquifyOnCollision,
        });
        imported += result.imported.length;
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
    dirtyMediaIds?: Set<number>,
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
        dirtyMediaIds?.add(matched.id);
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
        dirtyMediaIds?.add(matched.id);
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
