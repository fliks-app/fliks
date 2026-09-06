import {
  Injectable,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { relativePathUnderMediaRoot } from '../../common/utils/media-path.util';
import { sanitizeFsPath } from '../../common/utils/fs-path.util';
import { Media } from '../media/entities/media.entity';
import { hasProviderId } from '../media/media-identity.util';
import { MediaFile } from '../media/entities/media-file.entity';
import { Season } from '../media/entities/season.entity';
import { Episode } from '../media/entities/episode.entity';
import { Library } from '../libraries/entities/library.entity';
import { MediaType } from '../../common/enums';
import { parseReleaseQuality, extractMediaTitle } from '../../common/release-parsing';
import { ImportFileEntry } from './dto/confirm-disk-import.dto';
import { RelinkOrphansDto } from './dto/relink-orphans.dto';
import { PreviewOrphansDto } from './dto/preview-orphans.dto';
import {
  OrphanScanResult,
  OrphanGroup,
  OrphanFileEntry,
  RelinkResult,
} from './dto/orphan-scan.dto';
import { NfoMetadataService } from './nfo-metadata.service';
import { findLocalArtwork } from './local-artwork.util';
import { EventsService } from '../scheduler/events.service';
import { ActivityRegistryService } from '../scheduler/activity-registry.service';
import { mapWithConcurrency } from '../../common/utils/concurrency';
import { MediaService } from '../media/media.service';
import { MediaMetadataService } from '../media/media-service/media-metadata.service';
import { NamingService } from '../scheduler/naming.service';
import { LibrariesService } from '../libraries/libraries.service';
import { TransferMethod } from '../../common/services/file-transfer.service';
import { LibraryIngestService } from '../../common/library-ingest/library-ingest.service';
import { PostImportQueueService } from '../../common/post-import/post-import-queue.service';
import { MediaServersService } from '../media-servers/media-servers.service';
import { VIDEO_EXTS } from '../../common/constants/video-extensions';

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

/** The scan shares a 30-connection pool with everything else the server is
 *  serving; unbounded fan-out starved it and the UI stalled until the scan ended. */
const SCAN_CONCURRENCY = 8;

/** SSE task keys: the folder walk, then the background relink of its groups. */
export const ORPHAN_SCAN_PROGRESS = 'OrphanScan';
export const ORPHAN_IMPORT_PROGRESS = 'OrphanImport';

export interface NormalizedTitles {
  normTitle: string;
  normOriginal: string;
}

type ScanMedia = Pick<
  Media,
  'id' | 'title' | 'originalTitle' | 'year' | 'type'
> &
  NormalizedTitles;

export function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pure so the scan can hoist normalization out of its per-file loop. */
export function matchMedia<T extends NormalizedTitles>(
  extractedTitle: string,
  allMedia: readonly T[],
): T | null {
  const target = normalizeTitle(extractedTitle);
  if (!target) return null;

  // Exact match
  let match = allMedia.find(
    (m) => m.normTitle === target || m.normOriginal === target,
  );
  if (match) return match;

  // Target starts with media title (e.g. "inception 2010" -> "inception")
  match = allMedia.find(
    (m) => m.normTitle.length >= 2 && target.startsWith(m.normTitle),
  );
  if (match) return match;

  // Media title starts with target
  match = allMedia.find(
    (m) => m.normTitle.length >= 3 && m.normTitle.startsWith(target),
  );
  return match ?? null;
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
    private readonly naming: NamingService,
    private readonly libraries: LibrariesService,
    @Inject(forwardRef(() => MediaMetadataService))
    private readonly metadata: MediaMetadataService,
    private readonly nfo: NfoMetadataService,
    private readonly libraryIngest: LibraryIngestService,
    private readonly postImportQueue: PostImportQueueService,
    private readonly mediaServers: MediaServersService,
    private readonly events: EventsService,
    private readonly activityRegistry: ActivityRegistryService,
  ) {}

  /**
   * Walk a library's own root folder and surface video files not yet linked
   * to any media in that library (orphans), grouped so each unit can be
   * re-created from TMDB/TVDB and linked in place. Cheap: filename + .nfo
   * hints only, no ffprobe.
   */
  async scanLibraryOrphans(libraryId: number): Promise<OrphanScanResult> {
    const library = await this.libraries.requirePathFor(libraryId);

    // Absolute paths already linked in this library — never offered again.
    // Only the two columns the loop reads: the full rows drag every file's
    // `streamInfo` JSONB into the heap for nothing.
    const linkedRows = await this.fileRepo.find({
      where: { media: { library: { id: libraryId } } },
      select: {
        id: true,
        relativePath: true,
        media: { id: true, folderName: true, library: { id: true, path: true } },
      },
      relations: { media: { library: true } },
    });
    const linkedSet = new Set<string>();
    for (const f of linkedRows) {
      const base = f.media?.path ?? library.path!;
      linkedSet.add(
        path.resolve(path.join(base, f.relativePath.replace(/\\/g, '/'))),
      );
    }

    return this.scanOrphansUnder(
      library.path!,
      library.mediaTypes ?? [],
      library.preferredProvider ?? 'tmdb',
      linkedSet,
      `library #${libraryId}`,
    );
  }

  /**
   * Same scan against a bare folder, for a library that does not exist yet:
   * the creation wizard picks its matches before the library is written.
   */
  async previewOrphans(dto: PreviewOrphansDto): Promise<OrphanScanResult> {
    const root = path.resolve(dto.path);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(root);
    } catch {
      throw new BadRequestException(`Path not found: ${root}`);
    }
    if (!stat.isDirectory()) {
      throw new BadRequestException(`Not a directory: ${root}`);
    }
    return this.scanOrphansUnder(
      root,
      dto.mediaTypes ?? [MediaType.MOVIE, MediaType.SERIES],
      dto.preferredProvider ?? 'tmdb',
      new Set<string>(),
      `path "${root}"`,
    );
  }

  private async scanOrphansUnder(
    rootPath: string,
    mediaTypes: MediaType[],
    suggestedProvider: string,
    linkedSet: Set<string>,
    label: string,
  ): Promise<OrphanScanResult> {
    const root = path.resolve(rootPath);
    this.logger.log(`Orphan scan started — ${label} root="${root}"`);

    const allFiles = await this.collectVideoFiles(root, 0);
    const unlinked = allFiles.filter((abs) => !linkedSet.has(path.resolve(abs)));

    // One slot past the file count: the client retires a task at current >= total,
    // and the .nfo pass still runs after the last file is stat'd.
    let done = 0;
    const emit = (current: number) =>
      this.events.emit({
        type: 'task.progress',
        command: ORPHAN_SCAN_PROGRESS,
        current,
        total: unlinked.length + 1,
        message: root,
      });
    emit(0);

    // Pass 1 — one stat per file, in parallel: a sequential walk of a few
    // thousand files is minutes of round-trips on a NAS mount.
    const scanned = await mapWithConcurrency(
      unlinked,
      SCAN_CONCURRENCY,
      async (abs) => {
        if (++done % 25 === 0) emit(done);
        const filename = path.basename(abs);
        const epNums = this.naming.parseEpisodeNumbers(filename, abs);
        // Skip files whose inferred type the library doesn't accept (e.g. a
        // series file under a movies-only library) — they can't be re-linked here.
        // A special carries no numbering, so its own markers are what make it a series file.
        const inferredType =
          epNums || this.naming.isSpecialFile(abs)
            ? MediaType.SERIES
            : MediaType.MOVIE;
        if (!mediaTypes.includes(inferredType)) return null;

        const { quality } = parseReleaseQuality(filename);
        let size = 0;
        try {
          size = (await fsp.stat(abs)).size;
        } catch {
          /* ignore */
        }
        const rel = relativePathUnderMediaRoot(root, abs);
        const segments = rel ? rel.split('/') : [];
        return {
          abs,
          epNums,
          mediaType: inferredType,
          // A file directly at the library root has a single segment (its name).
          folderName: segments.length > 1 ? segments[0] : '',
          entry: {
            filePath: abs,
            filename,
            size,
            qualityName: quality.name,
            qualityId: quality.id,
            seasonNumber: epNums?.season ?? null,
            episodeNumber: epNums?.episode ?? null,
            episodeEnd: epNums?.episodeEnd ?? null,
          } satisfies OrphanFileEntry,
        };
      },
    );

    // Pass 2 — group in walk order, so a group's first file is its sample.
    const groups = new Map<string, OrphanGroup>();
    const sampleFile = new Map<string, string>();
    let orphanCount = 0;
    for (const f of scanned) {
      if (!f) continue;
      // A series file at the library root can't be grouped: a series needs a folder.
      if (!f.folderName && f.mediaType === MediaType.SERIES) continue;
      orphanCount++;
      const key =
        f.mediaType === MediaType.SERIES
          ? `series:${f.folderName}`
          : `movie:${f.abs}`;
      const existing = groups.get(key);
      if (existing) {
        existing.files.push(f.entry);
        continue;
      }
      groups.set(key, {
        groupKey: key,
        mediaType: f.mediaType,
        folderName: f.folderName,
        guessTitle: f.folderName,
        guessYear: null,
        nfo: null,
        suggestedProvider,
        files: [f.entry],
      });
      sampleFile.set(key, f.abs);
    }

    // Pass 3 — one .nfo probe per group instead of per file (each probe is up
    // to four reads), in parallel.
    await mapWithConcurrency(
      [...groups.values()],
      SCAN_CONCURRENCY,
      async (group) => {
        const abs = sampleFile.get(group.groupKey)!;
        const extracted = extractMediaTitle(path.basename(abs));
        const nfo = await this.nfo.readForVideoFile(abs);
        group.nfo = nfo;
        group.guessTitle = nfo?.title ?? extracted.title ?? group.folderName;
        group.guessYear = nfo?.year ?? extracted.year ?? null;
      },
    );
    emit(unlinked.length + 1);

    this.logger.log(
      `Orphan scan finished - ${label} scanned=${allFiles.length} orphans=${orphanCount} groups=${groups.size}`,
    );
    return {
      libraryPath: root,
      groups: [...groups.values()],
      scannedFiles: allFiles.length,
      orphanCount,
    };
  }

  /**
   * Import every group of one scan, sequentially — a single relink hammers
   * TMDB and the naming pipeline hard enough that parallelism buys nothing.
   * Called in the background: one slow group must not fail the others.
   */
  async relinkOrphansBatch(
    items: RelinkOrphansDto[],
    userId: number | null,
  ): Promise<{ groups: number; created: number; linked: number; failed: number }> {
    let created = 0;
    let linked = 0;
    let failed = 0;
    let index = 0;
    const activityId = (item: RelinkOrphansDto) =>
      `${ORPHAN_IMPORT_PROGRESS}:${item.type}:${item.folderName}`;
    // The whole backlog up front: this loop runs for hours on a large series, and
    // the queued groups are the part the user can't otherwise see.
    for (const item of items) {
      this.activityRegistry.upsertPending(
        activityId(item),
        ORPHAN_IMPORT_PROGRESS,
        { title: item.folderName },
        ORPHAN_IMPORT_PROGRESS,
      );
    }
    try {
      for (const item of items) {
        this.events.emit({
          type: 'task.progress',
          command: ORPHAN_IMPORT_PROGRESS,
          current: index++,
          total: items.length,
          message: item.folderName,
        });
        this.activityRegistry.upsertRunning(
          ORPHAN_IMPORT_PROGRESS,
          ORPHAN_IMPORT_PROGRESS,
          { title: item.folderName },
          index,
          items.length,
        );
        this.activityRegistry.upsertRunning(
          activityId(item),
          ORPHAN_IMPORT_PROGRESS,
          { title: item.folderName },
          undefined,
          undefined,
          ORPHAN_IMPORT_PROGRESS,
        );
        try {
          const res = await this.relinkOrphans(item, userId);
          if (res.created) created++;
          linked += res.linked;
          if (res.linked === 0) failed++;
        } catch (e) {
          failed++;
          this.logger.warn(
            `Orphan batch: "${item.folderName}" failed — ${(e as Error).message}`,
          );
        } finally {
          this.activityRegistry.remove(activityId(item));
        }
      }
    } finally {
      for (const item of items) this.activityRegistry.remove(activityId(item));
      this.activityRegistry.remove(ORPHAN_IMPORT_PROGRESS);
    }
    this.events.emit({
      type: 'task.progress',
      command: ORPHAN_IMPORT_PROGRESS,
      current: items.length,
      total: items.length,
      message: '',
    });
    this.logger.log(
      `Orphan batch finished — library #${items[0]?.libraryId} groups=${items.length} created=${created} linked=${linked} failed=${failed}`,
    );
    return { groups: items.length, created, linked, failed };
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
        `Library "${library.name}" does not accept ${dto.type}`,
      );
    }
    if (!dto.externalId && dto.reorganize) {
      throw new BadRequestException('Reorganize needs an identified title');
    }
    if (dto.folderName === '' && dto.reorganize) {
      throw new BadRequestException('Reorganize needs a title with its own folder');
    }

    const { media, created } = dto.externalId
      ? await this.findOrImportIdentified(dto, addedByUserId)
      : await this.findOrCreateUnmatched(dto, library, addedByUserId);

    if (media.library && media.library.id !== dto.libraryId) {
      throw new BadRequestException(
        `Media already belongs to another library ("${media.library.name}")`,
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
              : this.naming.parseEpisodeNumbers(filename, f.filePath);
          if (!epNums) {
            const special = await this.matchSpecialFile(media.id, f.filePath);
            if (!special) {
              errors.push(`${filename}: no SxxEyy pattern found`);
              continue;
            }
            episodeId = special.id;
          } else {
            const ep = await this.mediaService.ensureSeriesEpisode(media, epNums);
            episodeId = ep.episodeId ?? undefined;
            slotCreated ||= ep.created;
          }
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
        this.postImportQueue.enqueue({ mediaFileId: res.fileId });
      }
      // The reorganize branch above emits this from LibraryIngestService.
      if (linked > 0) {
        this.events.emitDomain({
          type: 'media.files.imported',
          mediaId: media.id,
          source: 'disk',
        });
      }
    }

    // Backfill metadata for any season/episode slot invented while linking.
    // An unmatched media has no provider id to refresh from, it would just throw.
    if (media.type === MediaType.SERIES && slotCreated && hasProviderId(media)) {
      try {
        await this.metadata.refreshSeriesEpisodes(media);
      } catch (e) {
        this.logger.warn(
          `Orphan relink: refreshSeriesEpisodes failed — ${(e as Error).message}`,
        );
      }
    }

    // A newly created unmatched row that failed to link any file is dead
    // weight: for a root movie especially, an ambiguous folderName '' twin
    // would otherwise linger and confuse the next reuse lookup.
    if (!dto.externalId && created && linked === 0) {
      await this.mediaRepo.delete(media.id);
    }

    this.logger.log(
      `Orphan relink — media #${media.id} created=${created} linked=${linked} errors=${errors.length}`,
    );
    return { mediaId: media.id, created, linked, errors };
  }

  /** Reuse the media holding this external id, or import it. */
  private async findOrImportIdentified(
    dto: RelinkOrphansDto,
    addedByUserId: number | null,
  ): Promise<{ media: Media; created: boolean }> {
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
            externalId: dto.externalId!,
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
      throw new BadRequestException('Media not found after import');
    }
    return { media, created };
  }

  /**
   * No external id: reuse the media already pinned to this folder, or create one from the
   * guessed/corrected title. Natural key is (library, type, folderName).
   */
  private async findOrCreateUnmatched(
    dto: RelinkOrphansDto,
    library: Library,
    addedByUserId: number | null,
  ): Promise<{ media: Media; created: boolean }> {
    const where = {
      library: { id: library.id },
      type: dto.type,
      folderName: dto.folderName,
      tmdbId: IsNull(),
      tvdbId: IsNull(),
      imdbId: IsNull(),
    };
    if (dto.folderName === '') {
      // Every root-level movie shares folderName '': disambiguate reuse by its
      // own file, or unrelated titles would collapse into the first one found.
      const wanted = new Set(dto.files.map((f) => path.basename(f.filePath)));
      const candidates = await this.mediaRepo.find({
        where,
        relations: ['library', 'files'],
      });
      const existing = candidates.find((m) =>
        (m.files ?? []).some((f) => wanted.has(f.relativePath)),
      );
      if (existing) return { media: existing, created: false };
    } else {
      const existing = await this.mediaRepo.findOne({
        where,
        relations: ['library', 'files'],
      });
      if (existing) return { media: existing, created: false };
    }

    const sample = path.resolve(dto.files[0].filePath);
    const artworkDir =
      dto.type === MediaType.SERIES
        ? path.join(library.path!, dto.folderName)
        : path.dirname(sample);
    // Checked independently: a crafted folderName must not escape the root even
    // when the sample file itself is a valid path under it.
    const libraryRoot = path.resolve(library.path!);
    const resolvedArtworkDir = path.resolve(artworkDir);
    if (
      relativePathUnderMediaRoot(library.path, sample) == null ||
      (resolvedArtworkDir !== libraryRoot &&
        !resolvedArtworkDir.startsWith(libraryRoot + path.sep))
    ) {
      throw new BadRequestException('File outside the library root');
    }

    // A root movie's artworkDir IS the shared library root: generic sidecar
    // names (poster.jpg, movie.nfo, ...) there belong to no title in particular.
    const isRootMovie = dto.folderName === '';
    const artworkBasename =
      dto.type === MediaType.SERIES
        ? undefined
        : path.basename(sample, path.extname(sample));
    const nfo =
      dto.type === MediaType.SERIES
        ? (await this.nfo.readNfoFile(path.join(artworkDir, 'tvshow.nfo'))) ??
          (await this.nfo.readForVideoFile(sample))
        : isRootMovie
          ? await this.nfo.readNfoFile(path.join(artworkDir, `${artworkBasename}.nfo`))
          : await this.nfo.readForVideoFile(sample);
    const artwork = await findLocalArtwork(artworkDir, artworkBasename, {
      basenameOnly: isRootMovie,
    });

    const created = await this.mediaService.createUnmatched(
      {
        title:
          dto.title?.trim() ||
          extractMediaTitle(path.basename(sample)).title ||
          dto.folderName,
        year: dto.year,
        type: dto.type,
        libraryId: dto.libraryId,
        folderName: dto.folderName,
        qualityProfileId: dto.qualityProfileId,
        languageProfileId: dto.languageProfileId,
        nfo: nfo ?? undefined,
        artwork,
      },
      addedByUserId,
    );
    const media = await this.mediaRepo.findOne({
      where: { id: created.id },
      relations: ['library', 'files'],
    });
    if (!media) {
      throw new BadRequestException('Media not found after import');
    }
    return { media, created: true };
  }

  async scanFolder(folderPath: string): Promise<ScanCandidate[]> {
    const resolved = path.resolve(sanitizeFsPath(folderPath));
    this.logger.log(`Disk library scan started — folder="${resolved}"`);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(resolved);
    } catch {
      throw new BadRequestException(
        `Path "${resolved}" does not exist or is not accessible`,
      );
    }
    if (!stat.isDirectory()) {
      throw new BadRequestException(`Path "${resolved}" is not a directory`);
    }

    const videoFiles = await this.collectVideoFiles(resolved, 0);
    if (!videoFiles.length) return [];

    const rows = await this.mediaRepo.find({
      select: ['id', 'title', 'originalTitle', 'year', 'type'],
    });
    // Normalize once: matchMedia scans the whole list per file, and re-running
    // the regexes there made the scan O(files x media) in regex work alone.
    const allMedia: ScanMedia[] = rows.map((m) => ({
      ...m,
      normTitle: normalizeTitle(m.title),
      normOriginal: normalizeTitle(m.originalTitle ?? ''),
    }));

    // `buildCandidate` may invent a fresh season / episode slot for any file
    // that references one we haven't pulled metadata for yet. Collect the
    // owning media so we can backfill those rows (titles, overviews, stills)
    // via the shared series refresh, instead of leaving them bare in the UI.
    const dirty = new Set<number>();
    const candidates = await mapWithConcurrency(
      videoFiles,
      SCAN_CONCURRENCY,
      (f) => this.buildCandidate(f, allMedia, dirty),
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
          await fsp.stat(entry.filePath);
        } catch {
          errors.push(
            `${path.basename(entry.filePath)}: source file not found`,
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
            `${path.basename(entry.filePath)}: library "${library.name}" does not accept ${media.type}`,
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
          files: [{ path: entry.filePath, episodeId: entry.episodeId }],
          transfer: method,
          fallbackQuality: entry.quality,
          sourceLabel: media.title,
          force: entry.force,
          uniquifyOnCollision: opts.uniquifyOnCollision,
        });
        imported += result.imported.length;
        if (result.imported.length) {
          void this.mediaServers.dispatch('library.rescan', {
            title: media.title,
            path: media.path,
          });
        }
      } catch (e) {
        errors.push(
          `${path.basename(entry.filePath)}: ${(e as Error).message}`,
        );
      }
    }

    return { imported, errors };
  }

  // ---------------------------------------------------------------------------

  private async collectVideoFiles(
    dir: string,
    depth: number,
  ): Promise<string[]> {
    if (depth > 3) return [];
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    const subdirs: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) subdirs.push(fullPath);
      else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
    // A library root holds one folder per title: descending them one at a time
    // is a few thousand serial round-trips on a NAS mount.
    const nested = await mapWithConcurrency(subdirs, SCAN_CONCURRENCY, (sub) =>
      this.collectVideoFiles(sub, depth + 1),
    );
    for (const chunk of nested) files.push(...chunk);
    return files;
  }

  private async buildCandidate(
    filePath: string,
    allMedia: ScanMedia[],
    dirtyMediaIds?: Set<number>,
  ): Promise<ScanCandidate> {
    const filename = path.basename(filePath);
    let size = 0;
    try {
      size = (await fsp.stat(filePath)).size;
    } catch {
      /* ignore */
    }

    const { quality } = parseReleaseQuality(filename);
    const epNums = this.naming.parseEpisodeNumbers(filename, filePath);
    const extractedTitle = this.extractTitle(filename);
    const matched = matchMedia(extractedTitle, allMedia);

    let episodeId: number | null = null;
    let episodeTitle: string | null = null;
    let special: Episode | null = null;

    if (matched?.type === 'series' && !epNums) {
      special = await this.matchSpecialFile(matched.id, filePath);
      episodeId = special?.id ?? null;
      episodeTitle = special?.title ?? null;
    }

    if (matched?.type === 'series' && epNums) {
      let season = await this.seasonRepo.findOne({
        where: { media: { id: matched.id }, seasonNumber: epNums.season },
      });
      if (!season) {
        season = await this.seasonRepo.save(
          this.seasonRepo.create({
            media: { id: matched.id } as Media,
            seasonNumber: epNums.season,
            monitored: epNums.season > 0,
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
      seasonNumber: epNums?.season ?? (special ? 0 : null),
      episodeNumber: epNums?.episode ?? special?.episodeNumber ?? null,
      mediaId: matched?.id ?? null,
      mediaTitle: matched?.title ?? null,
      mediaYear: matched?.year ?? null,
      mediaType: matched?.type ?? null,
      episodeId,
      episodeTitle,
      existingQuality: null,
    };
  }

  /**
   * A file that names itself a special but no episode number: match it against the season-0
   * rows by title. Never creates a row — an unplaceable special stays unmatched rather than
   * taking a number, which would attach it to the wrong one.
   */
  private async matchSpecialFile(
    mediaId: number,
    filePath: string,
  ): Promise<Episode | null> {
    const season = await this.seasonRepo.findOne({
      where: { media: { id: mediaId }, seasonNumber: 0 },
      relations: ['episodes'],
    });
    return this.naming.matchSpecialByTitle(
      path.basename(filePath),
      season?.episodes ?? [],
    );
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

}
