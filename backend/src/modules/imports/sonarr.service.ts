import { Injectable, Logger, BadRequestException } from '@nestjs/common';
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
  subtitlePathsBesideEpisode,
  suggestLocalRootFolderId,
  upsertImportedSubtitleFile,
} from '../scheduler/utils/arr-import.util';
import { PreviewImportResult } from './dto/preview-import.dto';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { MediaService } from '../media/media.service';
import { SubtitleProviderType } from '../../common/enums';
import { LibrariesService } from '../libraries/libraries.service';
import { Library } from '../libraries/entities/library.entity';
import type { ImportTargetSpec } from './radarr.service';
import * as path from 'path';
import { relativePathUnderMediaRoot } from '../../common/utils/media-path.util';

interface SonarrSeries {
  /** Sonarr API series id (required for extra files / episode files) */
  id?: number;
  title?: string;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  year?: number;
  monitored?: boolean;
  path?: string;
  /** Sonarr API: path of the library root */
  rootFolderPath?: string;
  overview?: string;
  qualityProfileId?: number;
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
export class ImportSonarrService {
  private readonly log = new Logger(ImportSonarrService.name);

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
    private readonly mediaService: MediaService,
    private readonly libraries: LibrariesService,
  ) {}

  private autoLibraryName(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `Sonarr Import ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  /**
   * Hits Sonarr's `/api/v3/system/status` to validate the URL + API key. Same
   * shape as Seerr / Radarr test results for symmetric frontend handling.
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
          message: `Sonarr returned ${res.status} ${res.statusText}`,
        };
      }
      const data = (await res.json()) as { instanceName?: string };
      return {
        ok: true,
        message: `Connecté à ${data.instanceName ?? 'Sonarr'}`,
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
          `Sonarr API returned ${res.status}: ${res.statusText}`,
        );
      }
      remoteFolders = (await res.json()) as { path: string }[];
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(
        `Cannot connect to Sonarr: ${(e as Error).message}`,
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
      mediaType: MediaType.SERIES,
      autoLabel: this.autoLibraryName(),
    });

    await this.assertMappingsBelongToLibrary(pathMappings, targetLibrary.id);

    let series: SonarrSeries[];
    try {
      const res = await fetch(`${baseUrl}/api/v3/series`, {
        headers: { 'X-Api-Key': apiKey },
      });
      if (!res.ok) {
        throw new BadRequestException(
          `Sonarr API returned ${res.status}: ${res.statusText}`,
        );
      }
      series = (await res.json()) as SonarrSeries[];
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(
        `Cannot connect to Sonarr: ${(e as Error).message}`,
      );
    }

    if (!Array.isArray(series) || !series.length) {
      return {
        imported: 0,
        errors: ['No series found in Sonarr'],
        rootFoldersCreated,
        qualityProfilesCreated,
      };
    }

    const profileMap = await this.importQualityProfiles(
      baseUrl,
      apiKey,
      qualityProfilesCreated,
    );

    const newSeriesIds: number[] = [];

    for (const s of series) {
      const title = s.title ?? '';
      const tmdbId = Number(s.tmdbId || s.tvdbId);
      if (!Number.isFinite(tmdbId)) {
        errors.push(`${title || '(no title)'}: no valid tmdbId or tvdbId`);
        continue;
      }
      try {
        const exists = await this.mediaRepo.findOne({
          where: { tmdbId, type: MediaType.SERIES },
        });
        const localProfileId =
          s.qualityProfileId != null
            ? profileMap.get(s.qualityProfileId)
            : undefined;

        const resolved = applyPathMapping(s.path, pathMappings);
        if (resolved === null) {
          errors.push(
            `${title || '(no title)'}: no path mapping for "${s.path ?? ''}"`,
          );
          continue;
        }
        if ('ignore' in resolved) continue;
        const { rootFolderId, folderName } = resolved;

        if (exists) {
          if (mode === 'skip') continue;
          await this.mediaRepo.update(exists.id, {
            title,
            year: s.year ?? exists.year,
            monitored: s.monitored ?? exists.monitored,
            rootFolder: { id: rootFolderId } as RootFolder,
            folderName,
            imdbId: s.imdbId || exists.imdbId,
            overview: s.overview || exists.overview,
            qualityProfileId: localProfileId ?? exists.qualityProfileId,
            library: { id: exists.libraryId ?? targetLibrary.id } as Library,
          });
        } else {
          const saved = await this.mediaRepo.save(
            this.mediaRepo.create({
              title,
              tmdbId,
              year: s.year ?? undefined,
              type: MediaType.SERIES,
              status: MediaStatus.CONTINUING,
              monitored: s.monitored ?? true,
              rootFolder: { id: rootFolderId } as RootFolder,
              library: targetLibrary,
              folderName,
              imdbId: s.imdbId || undefined,
              overview: s.overview || undefined,
              qualityProfileId: localProfileId ?? undefined,
            }),
          );
          newSeriesIds.push(saved.id);
        }
        imported++;
      } catch (e) {
        errors.push(`${title}: ${(e as Error).message}`);
      }
    }

    // Fetch seasons/episodes from TMDB for newly imported series (fire-and-forget)
    if (newSeriesIds.length) {
      this.log.log(
        `Sonarr import: refreshing metadata for ${newSeriesIds.length} new series`,
      );
      void this.refreshNewSeries(newSeriesIds);
    }

    let subtitlesImported = 0;
    if (importSubtitles) {
      subtitlesImported = await this.importSidecarSubtitlesForSyncedSeries(
        series,
        errors,
        mode,
      );
    }

    this.log.log(
      `Sonarr API import: ${imported} imported, ${subtitlesImported} subtitles, ${errors.length} errors`,
    );
    return {
      imported,
      errors,
      rootFoldersCreated,
      qualityProfilesCreated,
      subtitlesImported,
    };
  }

  /**
   * Sidecar subtitles next to already-imported episode files. Uses only Fliks DB +
   * disk (same paths as streaming); no Sonarr episodefile API.
   */
  private async importSidecarSubtitlesForSyncedSeries(
    seriesList: SonarrSeries[],
    errors: string[],
    mode: 'skip' | 'update',
  ): Promise<number> {
    let count = 0;

    for (const series of seriesList) {
      if (!series.id) continue;

      const tmdbId = Number(series.tmdbId || series.tvdbId);
      if (!Number.isFinite(tmdbId)) continue;

      const media = await this.mediaRepo.findOne({
        where: { tmdbId, type: MediaType.SERIES },
        relations: ['rootFolder'],
      });
      if (!media?.path) continue;

      try {
        const mediaFiles = await this.mediaFileRepo.find({
          where: { media: { id: media.id } },
          order: { id: 'ASC' },
        });

        for (const mediaFile of mediaFiles) {
          const subtitlePaths = await subtitlePathsBesideEpisode(
            media.path,
            mediaFile.relativePath,
          );

          for (const absSubtitlePath of subtitlePaths) {
            const relativeName = path.basename(absSubtitlePath);
            const lang = parseLanguageFromPath(relativeName);
            const tags = parseSubtitleTags(relativeName);
            const forced = tags.includes('forced');
            const rel = relativePathUnderMediaRoot(media.path, absSubtitlePath);
            if (!rel) {
              this.log.error(
                `Sonarr subtitles: path outside media root — mediaId=${media.id} path=${media.path} subtitle=${absSubtitlePath}`,
              );
              continue;
            }

            count += await upsertImportedSubtitleFile(this.subtitleRepo, {
              mediaId: media.id,
              mediaFileId: mediaFile.id,
              episodeId: mediaFile.episodeId,
              language: lang,
              forced,
              tags,
              relativePath: rel,
              mode,
              providerType: SubtitleProviderType.SONARR,
            });
          }
        }
      } catch (e) {
        const msg = (e as Error).message;
        this.log.error(
          `Sonarr subtitles: error for "${series.title ?? 'series'}": ${msg}`,
        );
        errors.push(`Subtitles for "${series.title ?? 'series'}": ${msg}`);
      }
    }

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

      this.log.log(`Found ${remoteProfiles.length} quality profiles in Sonarr`);

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
        this.log.log(`Created quality profile from Sonarr: ${remote.name}`);
      }
    } catch (e) {
      this.log.warn(
        `Could not import Sonarr quality profiles: ${(e as Error).message}`,
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
      if (item.quality?.name) {
        addQuality(item.quality.name, item.allowed);
      }
      if (item.items?.length) {
        for (const sub of item.items) {
          if (sub.quality?.name) {
            addQuality(sub.quality.name, sub.allowed);
          }
        }
      }
    }

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
    const normalized = remoteName.replace(/[\s\-_]/g, '').toLowerCase();
    return APP_QUALITIES.find(
      (q) => q.name.replace(/[\s\-_]/g, '').toLowerCase() === normalized,
    );
  }

  private resolveCutoff(
    remoteCutoffId: number,
    remoteItems: RemoteQualityItem[],
  ): number {
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
    return 16;
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

  /** Fetch seasons/episodes from TMDB for newly imported series (best-effort). */
  private async refreshNewSeries(ids: number[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.mediaService.refreshMetadata(id);
      } catch (e) {
        this.log.warn(
          `Could not refresh metadata for series #${id}: ${(e as Error).message}`,
        );
      }
    }
    this.log.log(
      `Sonarr import: metadata refreshed for ${ids.length} new series`,
    );
  }
}
