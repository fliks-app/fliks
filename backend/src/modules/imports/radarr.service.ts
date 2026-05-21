import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
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
  applyPathMapping,
  parseLanguageFromPath,
  parseSubtitleTags,
  type PathMapping,
  suggestLocalRootFolderId,
  SUBTITLE_FILE_EXTENSIONS,
  upsertImportedSubtitleFile,
} from '../scheduler/utils/arr-import.util';
import { PreviewImportResult } from './dto/preview-import.dto';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleProviderType } from '../../common/enums';
import { LibrariesService } from '../libraries/libraries.service';
import { Library } from '../libraries/entities/library.entity';
import * as path from 'path';

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
    private readonly libraries: LibrariesService,
  ) {}

  /**
   * Hits Radarr's `/api/v3/system/status` to validate the URL + API key. Same
   * shape as Seerr's test result for symmetric frontend handling.
   */
  async testConnection(
    url: string,
    apiKey: string,
  ): Promise<{ ok: boolean; message: string }> {
    const baseUrl = url.replace(/\/+$/, '');
    try {
      const res = await fetch(`${baseUrl}/api/v3/system/status`, {
        headers: { 'X-Api-Key': apiKey },
      });
      if (!res.ok) {
        return {
          ok: false,
          message: `Radarr returned ${res.status} ${res.statusText}`,
        };
      }
      const data = (await res.json()) as { instanceName?: string };
      return {
        ok: true,
        message: `Connecté à ${data.instanceName ?? 'Radarr'}`,
      };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /**
   * Wizard step before the import: returns the *arr's root folders alongside
   * a server-side suggestion for which Fliks RootFolder to map each one to.
   * Pure read — no DB writes.
   */
  async previewRootFolders(
    url: string,
    apiKey: string,
  ): Promise<PreviewImportResult> {
    const baseUrl = url.replace(/\/+$/, '');
    let remoteFolders: { path: string }[];
    try {
      const res = await fetch(`${baseUrl}/api/v3/rootfolder`, {
        headers: { 'X-Api-Key': apiKey },
      });
      if (!res.ok) {
        throw new BadRequestException(
          `Radarr API returned ${res.status}: ${res.statusText}`,
        );
      }
      remoteFolders = (await res.json()) as { path: string }[];
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(
        `Cannot connect to Radarr: ${(e as Error).message}`,
      );
    }
    const localRootFolders = await this.rootFolderRepo.find();
    return {
      remoteRootFolders: remoteFolders
        .filter((r) => r.path?.trim())
        .map((r) => ({
          remotePath: r.path,
          suggestedLocalRootFolderId: suggestLocalRootFolderId(
            r.path,
            localRootFolders,
          ),
        })),
      localRootFolders: localRootFolders.map((rf) => ({
        id: rf.id,
        path: rf.path,
        libraryId: rf.libraryId ?? null,
      })),
    };
  }

  async importFromApi(
    url: string,
    apiKey: string,
    mode: 'skip' | 'update' = 'skip',
    importSubtitles = false,
    pathMappings: PathMapping[] = [],
    targetLibraryId: number,
  ): Promise<ApiImportResult> {
    const baseUrl = url.replace(/\/+$/, '');
    let imported = 0;
    const errors: string[] = [];
    const rootFoldersCreated: string[] = [];
    const qualityProfilesCreated: string[] = [];

    const targetLibrary = await this.libraries.resolveTargetLibrary({
      targetLibraryId,
      mediaType: MediaType.MOVIE,
    });

    await this.assertMappingsBelongToLibrary(pathMappings, targetLibrary.id);

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

    const profileMap = await this.importQualityProfiles(
      baseUrl,
      apiKey,
      qualityProfilesCreated,
    );

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

        const resolved = applyPathMapping(movie.path, pathMappings);
        if (resolved === null) {
          errors.push(
            `${title || '(no title)'}: no path mapping for "${movie.path ?? ''}"`,
          );
          continue;
        }
        if ('ignore' in resolved) continue;
        const { rootFolderId, folderName } = resolved;

        if (exists) {
          if (mode === 'skip') continue;
          // mode === 'update': update existing fields without deleting
          await this.mediaRepo.update(exists.id, {
            title,
            year: movie.year ?? exists.year,
            monitored: movie.monitored ?? exists.monitored,
            rootFolder: { id: rootFolderId } as RootFolder,
            folderName,
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
              rootFolder: { id: rootFolderId } as RootFolder,
              library: targetLibrary,
              folderName,
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
    // Normalize: remove spaces, dashes, case -> e.g. "webdl1080p"
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

  /**
   * Up-front guard: every mapping that targets a Fliks RootFolder must point
   * to one whose library is unassigned or matches the import target. We
   * refuse to silently re-home a RootFolder belonging to another library.
   */
  private async assertMappingsBelongToLibrary(
    pathMappings: PathMapping[],
    targetLibraryId: number,
  ): Promise<void> {
    const ids = Array.from(
      new Set(
        pathMappings
          .filter((m) => !m.ignore && m.localRootFolderId != null)
          .map((m) => m.localRootFolderId as number),
      ),
    );
    if (!ids.length) return;
    const folders = await this.rootFolderRepo.findByIds(ids);
    const offending: string[] = [];
    for (const id of ids) {
      const rf = folders.find((f) => f.id === id);
      if (!rf) {
        offending.push(`RootFolder #${id}: not found`);
        continue;
      }
      if (rf.libraryId != null && rf.libraryId !== targetLibraryId) {
        offending.push(
          `"${rf.path}" belongs to library #${rf.libraryId} (target is #${targetLibraryId})`,
        );
      }
    }
    if (offending.length) {
      throw new BadRequestException(
        `Path mappings reference root folders from another library: ${offending.join('; ')}`,
      );
    }
  }
}
