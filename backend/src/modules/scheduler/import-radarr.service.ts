import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Media } from '../media/entities/media.entity';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import {
  QualityProfile,
  QualityProfileItem,
} from '../profiles/entities/quality-profile.entity';
import { APP_QUALITIES } from '../../common/constants/app-qualities';
import { MediaType, MediaStatus } from '../../common/enums';
import {
  withTemporaryRestoredDatabase,
  queryRadarrMovies,
  queryRadarrRootFolderPaths,
  rowMonitored,
} from './pg-restore-import.util';
import {
  ensureRootFolderPathsExist,
  parseLanguageFromPath,
  parseSubtitleTags,
  resolveRootFolderFromArrPaths,
  SUBTITLE_FILE_EXTENSIONS,
  upsertImportedSubtitleFile,
} from './utils/arr-import.util';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleProviderType } from '../../common/enums';
import { LibrariesService } from '../libraries/libraries.service';
import { Library } from '../libraries/entities/library.entity';
import * as path from 'path';

export interface ImportTargetSpec {
  targetLibraryId?: number;
  newLibraryName?: string;
}

interface RadarrMovie {
  id?: number;
  title?: string;
  tmdbId?: number;
  imdbId?: string;
  year?: number;
  monitored?: boolean;
  path?: string;
  /** Radarr API: path of the library root */
  rootFolderPath?: string;
  overview?: string;
  qualityProfileId?: number;
  movieFile?: {
    relativePath?: string;
    size?: number;
    quality?: { quality?: { name?: string } };
  };
}

interface RadarrExtraFile {
  movieId: number;
  relativePath: string;
  extension: string;
  type: string;
  /** Language object from Radarr v3+ */
  language?: { name?: string; id?: number };
  /** Tags from filename parsing (e.g. "forced", "sdh", "cc") */
  tags?: string[];
}

interface RemoteQualityItem {
  allowed: boolean;
  quality?: { id: number; name: string } | null;
  items?: RemoteQualityItem[];
}

interface RemoteQualityProfile {
  id: number;
  name: string;
  upgradeAllowed: boolean;
  cutoff: number;
  items: RemoteQualityItem[];
}

export interface ApiImportResult {
  imported: number;
  errors: string[];
  rootFoldersCreated: string[];
  qualityProfilesCreated: string[];
  subtitlesImported?: number;
}

@Injectable()
export class ImportRadarrService {
  private readonly log = new Logger(ImportRadarrService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(RootFolder)
    private readonly rootFolderRepo: Repository<RootFolder>,
    @InjectRepository(QualityProfile)
    private readonly qpRepo: Repository<QualityProfile>,
    @InjectRepository(SubtitleFile)
    private readonly subtitleRepo: Repository<SubtitleFile>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    private readonly config: ConfigService,
    private readonly libraries: LibrariesService,
  ) {}

  private autoLibraryName(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `Radarr Import ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  async importFromApi(
    url: string,
    apiKey: string,
    mode: 'skip' | 'update' = 'skip',
    importSubtitles = false,
    target: ImportTargetSpec = {},
  ): Promise<ApiImportResult> {
    const baseUrl = url.replace(/\/+$/, '');
    let imported = 0;
    const errors: string[] = [];
    const rootFoldersCreated: string[] = [];
    const qualityProfilesCreated: string[] = [];

    const targetLibrary = await this.libraries.resolveTargetLibrary({
      targetLibraryId: target.targetLibraryId,
      newLibraryName: target.newLibraryName,
      mediaType: MediaType.MOVIE,
      autoLabel: this.autoLibraryName(),
    });

    let movies: RadarrMovie[];
    try {
      const res = await fetch(`${baseUrl}/api/v3/movie`, {
        headers: { 'X-Api-Key': apiKey },
      });
      if (!res.ok) {
        throw new BadRequestException(
          `Radarr API returned ${res.status}: ${res.statusText}`,
        );
      }
      movies = (await res.json()) as RadarrMovie[];
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(
        `Cannot connect to Radarr: ${(e as Error).message}`,
      );
    }

    if (!Array.isArray(movies) || !movies.length) {
      return {
        imported: 0,
        errors: ['No movies found in Radarr'],
        rootFoldersCreated,
        qualityProfilesCreated,
      };
    }

    await this.reconcileRootFolders(
      baseUrl,
      apiKey,
      rootFoldersCreated,
      targetLibrary.id,
      errors,
    );
    const profileMap = await this.importQualityProfiles(
      baseUrl,
      apiKey,
      qualityProfilesCreated,
    );

    const rootFolders = await this.rootFolderRepo.find();

    for (const movie of movies) {
      const title = movie.title ?? '';
      const tmdbId = Number(movie.tmdbId);
      if (!Number.isFinite(tmdbId)) {
        errors.push(`${title || '(no title)'}: invalid tmdbId`);
        continue;
      }
      try {
        const exists = await this.mediaRepo.findOne({
          where: { tmdbId, type: MediaType.MOVIE },
        });
        const localProfileId =
          movie.qualityProfileId != null
            ? profileMap.get(movie.qualityProfileId)
            : undefined;

        const resolved = resolveRootFolderFromArrPaths(
          movie.path,
          movie.rootFolderPath,
          rootFolders,
        );
        const folderName =
          resolved?.folderName ??
          (movie.path
            ? path.basename(movie.path.replace(/\/+$/, ''))
            : undefined);

        if (exists) {
          if (mode === 'skip') continue;
          // mode === 'update': update existing fields without deleting
          await this.mediaRepo.update(exists.id, {
            title,
            year: movie.year ?? exists.year,
            monitored: movie.monitored ?? exists.monitored,
            folderName: folderName || exists.folderName,
            imdbId: movie.imdbId || exists.imdbId,
            overview: movie.overview || exists.overview,
            qualityProfileId: localProfileId ?? exists.qualityProfileId,
            library: { id: exists.libraryId ?? targetLibrary.id } as Library,
          });
        } else {
          await this.mediaRepo.save(
            this.mediaRepo.create({
              title,
              tmdbId,
              year: movie.year ?? undefined,
              type: MediaType.MOVIE,
              status: MediaStatus.RELEASED,
              monitored: movie.monitored ?? true,
              rootFolder: resolved?.rootFolderId
                ? ({ id: resolved.rootFolderId } as RootFolder)
                : null,
              library: targetLibrary,
              folderName: folderName || undefined,
              imdbId: movie.imdbId || undefined,
              overview: movie.overview || undefined,
              qualityProfileId: localProfileId ?? undefined,
            }),
          );
        }
        imported++;
      } catch (e) {
        errors.push(`${title}: ${(e as Error).message}`);
      }
    }

    // Import subtitles if requested
    let subtitlesImported = 0;
    if (importSubtitles) {
      subtitlesImported = await this.importSubtitlesFromRadarr(
        baseUrl,
        apiKey,
        movies,
        errors,
        mode,
      );
    }

    this.log.log(
      `Radarr API import: ${imported} imported, ${subtitlesImported} subtitles, ${errors.length} errors`,
    );
    return {
      imported,
      errors,
      rootFoldersCreated,
      qualityProfilesCreated,
      subtitlesImported,
    };
  }

  private async importSubtitlesFromRadarr(
    baseUrl: string,
    apiKey: string,
    movies: RadarrMovie[],
    errors: string[],
    mode: 'skip' | 'update',
  ): Promise<number> {
    let count = 0;

    for (const movie of movies) {
      if (!movie.id || !movie.tmdbId) continue;

      const media = await this.mediaRepo.findOne({
        where: { tmdbId: movie.tmdbId, type: MediaType.MOVIE },
      });
      if (!media) continue;

      const mediaFile = await this.mediaFileRepo.findOne({
        where: { media: { id: media.id } },
        order: { id: 'DESC' },
      });
      if (!mediaFile) continue;

      try {
        const res = await fetch(
          `${baseUrl}/api/v3/extrafile?movieId=${movie.id}`,
          {
            headers: { 'X-Api-Key': apiKey },
          },
        );
        if (!res.ok) continue;
        const extras = (await res.json()) as RadarrExtraFile[];

        for (const extra of extras) {
          if (extra.type !== 'subtitle') continue;
          const ext = path.extname(extra.relativePath).toLowerCase();
          if (!SUBTITLE_FILE_EXTENSIONS.has(ext)) continue;

          const lang =
            extra.language?.name?.toLowerCase() ??
            parseLanguageFromPath(extra.relativePath);
          const tags = parseSubtitleTags(extra.relativePath);
          const forced = tags.includes('forced');
          const relativePath = extra.relativePath?.trim() || null;
          if (!relativePath) continue;

          count += await upsertImportedSubtitleFile(this.subtitleRepo, {
            mediaId: media.id,
            mediaFileId: mediaFile.id,
            language: lang,
            forced,
            tags,
            relativePath,
            mode,
            providerType: SubtitleProviderType.RADARR,
          });
        }
      } catch (e) {
        errors.push(`Subtitles for "${movie.title}": ${(e as Error).message}`);
      }
    }

    this.log.log(`Radarr subtitle import: ${count} subtitles imported`);
    return count;
  }

  private async importQualityProfiles(
    baseUrl: string,
    apiKey: string,
    created: string[],
  ): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    try {
      const res = await fetch(`${baseUrl}/api/v3/qualityprofile`, {
        headers: { 'X-Api-Key': apiKey },
      });
      if (!res.ok) return map;
      const remoteProfiles = (await res.json()) as RemoteQualityProfile[];
      const existingProfiles = await this.qpRepo.find();
      const existingByName = new Map(existingProfiles.map((p) => [p.name, p]));

      this.log.log(`Found ${remoteProfiles.length} quality profiles in Radarr`);

      for (const remote of remoteProfiles) {
        const existing = existingByName.get(remote.name);
        if (existing) {
          map.set(remote.id, existing.id);
          this.log.log(
            `Quality profile "${remote.name}" already exists (local #${existing.id})`,
          );
          continue;
        }

        const items = this.mapRemoteItems(remote.items);
        const cutoffId = this.resolveCutoff(remote.cutoff, remote.items);

        const saved = await this.qpRepo.save(
          this.qpRepo.create({
            name: remote.name,
            cutoff: cutoffId,
            upgradeAllowed: remote.upgradeAllowed,
            items,
          }),
        );
        map.set(remote.id, saved.id);
        created.push(remote.name);
        this.log.log(`Created quality profile from Radarr: ${remote.name}`);
      }
    } catch (e) {
      this.log.warn(
        `Could not import Radarr quality profiles: ${(e as Error).message}`,
      );
    }
    return map;
  }

  private mapRemoteItems(
    remoteItems: RemoteQualityItem[],
  ): QualityProfileItem[] {
    const items: QualityProfileItem[] = [];
    let sortOrder = 0;

    const addQuality = (name: string, allowed: boolean) => {
      const local = this.findLocalQuality(name);
      if (local) {
        items.push({
          quality: {
            id: local.id,
            name: local.name,
            resolution: local.resolution,
            source: local.source,
          },
          allowed,
          sortOrder: sortOrder++,
        });
      }
    };

    for (const item of remoteItems) {
      // Single quality
      if (item.quality?.name) {
        addQuality(item.quality.name, item.allowed);
      }
      // Group: flatten sub-items
      if (item.items?.length) {
        for (const sub of item.items) {
          if (sub.quality?.name) {
            addQuality(sub.quality.name, sub.allowed);
          }
        }
      }
    }

    // Fill in missing qualities as not allowed
    const presentIds = new Set(items.map((i) => i.quality.id));
    for (const q of APP_QUALITIES) {
      if (!presentIds.has(q.id)) {
        items.push({
          quality: {
            id: q.id,
            name: q.name,
            resolution: q.resolution,
            source: q.source,
          },
          allowed: false,
          sortOrder: sortOrder++,
        });
      }
    }

    return items;
  }

  private findLocalQuality(remoteName: string) {
    // Normalize: remove spaces, dashes, case → e.g. "webdl1080p"
    const normalized = remoteName.replace(/[\s\-_]/g, '').toLowerCase();
    return APP_QUALITIES.find(
      (q) => q.name.replace(/[\s\-_]/g, '').toLowerCase() === normalized,
    );
  }

  /** Map Radarr cutoff quality ID to our local quality ID. */
  private resolveCutoff(
    remoteCutoffId: number,
    remoteItems: RemoteQualityItem[],
  ): number {
    // Find the quality name that matches the remote cutoff ID
    const findName = (items: RemoteQualityItem[]): string | undefined => {
      for (const item of items) {
        if (item.quality?.id === remoteCutoffId) return item.quality.name;
        if (item.items?.length) {
          const found = findName(item.items);
          if (found) return found;
        }
      }
      return undefined;
    };
    const name = findName(remoteItems);
    if (name) {
      const local = this.findLocalQuality(name);
      if (local) return local.id;
    }
    return 16; // fallback WEBDL-1080p
  }

  private async reconcileRootFolders(
    baseUrl: string,
    apiKey: string,
    rootFoldersCreated: string[],
    libraryId: number,
    warnings: string[],
  ): Promise<void> {
    try {
      const rfRes = await fetch(`${baseUrl}/api/v3/rootfolder`, {
        headers: { 'X-Api-Key': apiKey },
      });
      if (rfRes.ok) {
        const remoteFolders = (await rfRes.json()) as { path: string }[];
        const before = rootFoldersCreated.length;
        await ensureRootFolderPathsExist(
          this.rootFolderRepo,
          remoteFolders.map((r) => r.path),
          rootFoldersCreated,
          libraryId,
          warnings,
        );
        for (let i = before; i < rootFoldersCreated.length; i++) {
          this.log.log(
            `Created root folder from Radarr: ${rootFoldersCreated[i]}`,
          );
        }
      }
    } catch (e) {
      this.log.warn(
        `Could not fetch Radarr root folders: ${(e as Error).message}`,
      );
    }
  }

  async importFromDump(
    buffer: Buffer,
    target: ImportTargetSpec = {},
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    if (!buffer?.length) {
      throw new BadRequestException('Empty file');
    }

    let imported = 0;
    const errors: string[] = [];

    const targetLibrary = await this.libraries.resolveTargetLibrary({
      targetLibraryId: target.targetLibraryId,
      newLibraryName: target.newLibraryName,
      mediaType: MediaType.MOVIE,
      autoLabel: this.autoLibraryName(),
    });

    try {
      await withTemporaryRestoredDatabase(
        this.config,
        buffer,
        async (client) => {
          const dumpPaths = await queryRadarrRootFolderPaths(client);
          const createdRf: string[] = [];
          await ensureRootFolderPathsExist(
            this.rootFolderRepo,
            dumpPaths,
            createdRf,
            targetLibrary.id,
            errors,
          );
          for (const p of createdRf) {
            this.log.log(`Created root folder from Radarr dump: ${p}`);
          }

          const rows = await queryRadarrMovies(client);
          if (!rows.length) {
            errors.push('No movies found in database');
            return;
          }

          const rootFolders = await this.rootFolderRepo.find();

          for (const row of rows) {
            const title = row.title ?? '';
            const tmdbId = Number(row.tmdbId);
            if (!Number.isFinite(tmdbId)) {
              errors.push(`${title || '(no title)'}: invalid TmdbId`);
              continue;
            }
            try {
              const exists = await this.mediaRepo.findOne({
                where: { tmdbId, type: MediaType.MOVIE },
              });

              const resolved = resolveRootFolderFromArrPaths(
                row.path,
                row.rootFolderPath,
                rootFolders,
              );
              const folderName =
                resolved?.folderName ??
                (row.path
                  ? path.basename(row.path.replace(/\/+$/, ''))
                  : undefined);

              if (exists) {
                await this.mediaRepo.update(exists.id, {
                  title,
                  year: row.year ?? undefined,
                  monitored: rowMonitored(row.monitored),
                  rootFolder: resolved?.rootFolderId
                    ? ({ id: resolved.rootFolderId } as RootFolder)
                    : null,
                  library: { id: exists.libraryId ?? targetLibrary.id } as Library,
                  folderName: folderName || undefined,
                });
              } else {
                await this.mediaRepo.save(
                  this.mediaRepo.create({
                    title,
                    tmdbId,
                    year: row.year ?? undefined,
                    type: MediaType.MOVIE,
                    status: MediaStatus.RELEASED,
                    monitored: rowMonitored(row.monitored),
                    rootFolder: resolved?.rootFolderId
                      ? ({ id: resolved.rootFolderId } as RootFolder)
                      : null,
                    library: targetLibrary,
                    folderName: folderName || undefined,
                  }),
                );
              }
              imported++;
            } catch (e) {
              errors.push(`${title}: ${(e as Error).message}`);
            }
          }
        },
      );
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    this.log.log(
      `Radarr import: ${imported} imported, ${errors.length} errors`,
    );
    return { imported, skipped: 0, errors };
  }
}
