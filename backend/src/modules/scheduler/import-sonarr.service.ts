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
import { SUITARR_QUALITIES } from '../../common/constants/suitarr-qualities';
import { MediaType, MediaStatus } from '../../common/enums';
import {
  withTemporaryRestoredDatabase,
  querySonarrSeries,
  querySonarrRootFolderPaths,
  rowMonitored,
} from './pg-restore-import.util';
import {
  ensureRootFolderPathsExist,
  parseLanguageFromPath,
  parseSubtitleTags,
  resolveRootFolderFromArrPaths,
  subtitlePathsBesideEpisode,
  upsertImportedSubtitleFile,
} from './utils/arr-import.util';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleProviderType } from '../../common/enums';
import * as path from 'path';

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
    private readonly config: ConfigService,
  ) {}

  async importFromApi(
    url: string,
    apiKey: string,
    mode: 'skip' | 'update' = 'skip',
    importSubtitles = false,
  ): Promise<ApiImportResult> {
    const baseUrl = url.replace(/\/+$/, '');
    let imported = 0;
    const errors: string[] = [];
    const rootFoldersCreated: string[] = [];
    const qualityProfilesCreated: string[] = [];

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

    await this.reconcileRootFolders(baseUrl, apiKey, rootFoldersCreated);
    const profileMap = await this.importQualityProfiles(
      baseUrl,
      apiKey,
      qualityProfilesCreated,
    );

    const rootFolders = await this.rootFolderRepo.find();

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

        const resolved = resolveRootFolderFromArrPaths(
          s.path,
          s.rootFolderPath,
          rootFolders,
        );
        const folderName =
          resolved?.folderName ??
          (s.path ? path.basename(s.path.replace(/\/+$/, '')) : undefined);

        if (exists) {
          if (mode === 'skip') continue;
          await this.mediaRepo.update(exists.id, {
            title,
            year: s.year ?? exists.year,
            monitored: s.monitored ?? exists.monitored,
            folderName: folderName || exists.folderName,
            imdbId: s.imdbId || exists.imdbId,
            overview: s.overview || exists.overview,
            qualityProfileId: localProfileId ?? exists.qualityProfileId,
          });
        } else {
          await this.mediaRepo.save(
            this.mediaRepo.create({
              title,
              tmdbId,
              year: s.year ?? undefined,
              type: MediaType.SERIES,
              status: MediaStatus.CONTINUING,
              monitored: s.monitored ?? true,
              rootFolderId: resolved?.rootFolderId,
              folderName: folderName || undefined,
              imdbId: s.imdbId || undefined,
              overview: s.overview || undefined,
              qualityProfileId: localProfileId ?? undefined,
            }),
          );
        }
        imported++;
      } catch (e) {
        errors.push(`${title}: ${(e as Error).message}`);
      }
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
   * Sidecar subtitles next to already-imported episode files. Uses only Suitarr DB +
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
          where: { mediaId: media.id },
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
            const rel = path.relative(media.path, absSubtitlePath);
            if (!rel || rel.startsWith('..')) continue;

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
    for (const q of SUITARR_QUALITIES) {
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
    return SUITARR_QUALITIES.find(
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

  private async reconcileRootFolders(
    baseUrl: string,
    apiKey: string,
    rootFoldersCreated: string[],
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
        );
        for (let i = before; i < rootFoldersCreated.length; i++) {
          this.log.log(
            `Created root folder from Sonarr: ${rootFoldersCreated[i]}`,
          );
        }
      }
    } catch (e) {
      this.log.warn(
        `Could not fetch Sonarr root folders: ${(e as Error).message}`,
      );
    }
  }

  async importFromDump(
    buffer: Buffer,
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    if (!buffer?.length) {
      throw new BadRequestException('Empty file');
    }

    let imported = 0;
    const errors: string[] = [];

    try {
      await withTemporaryRestoredDatabase(
        this.config,
        buffer,
        async (client) => {
          const dumpPaths = await querySonarrRootFolderPaths(client);
          const createdRf: string[] = [];
          await ensureRootFolderPathsExist(
            this.rootFolderRepo,
            dumpPaths,
            createdRf,
          );
          for (const p of createdRf) {
            this.log.log(`Created root folder from Sonarr dump: ${p}`);
          }

          const rows = await querySonarrSeries(client);
          if (!rows.length) {
            errors.push('No series found in database');
            return;
          }

          const rootFolders = await this.rootFolderRepo.find();

          for (const row of rows) {
            const title = row.title ?? '';
            const externalId = Number(row.externalId);
            if (!Number.isFinite(externalId)) {
              errors.push(`${title || '(no title)'}: invalid external id`);
              continue;
            }
            try {
              const exists = await this.mediaRepo.findOne({
                where: { tmdbId: externalId, type: MediaType.SERIES },
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
                  rootFolderId: resolved?.rootFolderId,
                  folderName: folderName || undefined,
                });
              } else {
                await this.mediaRepo.save(
                  this.mediaRepo.create({
                    title,
                    tmdbId: externalId,
                    year: row.year ?? undefined,
                    type: MediaType.SERIES,
                    status: MediaStatus.CONTINUING,
                    monitored: rowMonitored(row.monitored),
                    rootFolderId: resolved?.rootFolderId,
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
      `Sonarr import: ${imported} imported, ${errors.length} errors`,
    );
    return { imported, skipped: 0, errors };
  }
}
