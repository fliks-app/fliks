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
  queryRadarrMovies,
  rowMonitored,
} from './pg-restore-import.util';
import * as path from 'path';

interface RadarrMovie {
  title?: string;
  tmdbId?: number;
  imdbId?: string;
  year?: number;
  monitored?: boolean;
  path?: string;
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
    private readonly config: ConfigService,
  ) {}

  async importFromApi(url: string, apiKey: string): Promise<ApiImportResult> {
    const baseUrl = url.replace(/\/+$/, '');
    let imported = 0;
    const errors: string[] = [];
    const rootFoldersCreated: string[] = [];
    const qualityProfilesCreated: string[] = [];

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

    await this.reconcileRootFolders(baseUrl, apiKey, rootFoldersCreated);
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

        if (exists) {
          await this.mediaRepo.remove(exists);
        }

        const folderName = movie.path
          ? path.basename(movie.path.replace(/\/+$/, ''))
          : undefined;
        await this.mediaRepo.save(
          this.mediaRepo.create({
            title,
            tmdbId,
            year: movie.year ?? undefined,
            type: MediaType.MOVIE,
            status: MediaStatus.RELEASED,
            monitored: movie.monitored ?? true,
            path: movie.path || undefined,
            folderName: folderName || undefined,
            imdbId: movie.imdbId || undefined,
            overview: movie.overview || undefined,
            qualityProfileId: localProfileId ?? undefined,
          }),
        );
        imported++;
      } catch (e) {
        errors.push(`${title}: ${(e as Error).message}`);
      }
    }

    this.log.log(
      `Radarr API import: ${imported} imported, ${errors.length} errors`,
    );
    return { imported, errors, rootFoldersCreated, qualityProfilesCreated };
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
    // Normalize: remove spaces, dashes, case → e.g. "webdl1080p"
    const normalized = remoteName.replace(/[\s\-_]/g, '').toLowerCase();
    return SUITARR_QUALITIES.find(
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
  ): Promise<void> {
    try {
      const rfRes = await fetch(`${baseUrl}/api/v3/rootfolder`, {
        headers: { 'X-Api-Key': apiKey },
      });
      if (rfRes.ok) {
        const remoteFolders = (await rfRes.json()) as { path: string }[];
        const existing = await this.rootFolderRepo.find();
        const existingPaths = new Set(
          existing.map((f) => f.path.replace(/\/+$/, '')),
        );

        for (const rf of remoteFolders) {
          const normalized = rf.path.replace(/\/+$/, '');
          if (!existingPaths.has(normalized)) {
            try {
              await this.rootFolderRepo.save(
                this.rootFolderRepo.create({ path: rf.path }),
              );
              rootFoldersCreated.push(rf.path);
              this.log.log(`Created root folder from Radarr: ${rf.path}`);
            } catch (e) {
              this.log.warn(
                `Could not create root folder ${rf.path}: ${(e as Error).message}`,
              );
            }
          }
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
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    if (!buffer?.length) {
      throw new BadRequestException('Empty file');
    }

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    try {
      await withTemporaryRestoredDatabase(
        this.config,
        buffer,
        async (client) => {
          const rows = await queryRadarrMovies(client);
          if (!rows.length) {
            errors.push('No movies found in database');
            return;
          }

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
              if (exists) {
                skipped++;
                continue;
              }

              const folderName = row.path
                ? path.basename(row.path.replace(/\/+$/, ''))
                : undefined;
              await this.mediaRepo.save(
                this.mediaRepo.create({
                  title,
                  tmdbId,
                  year: row.year ?? undefined,
                  type: MediaType.MOVIE,
                  status: MediaStatus.RELEASED,
                  monitored: rowMonitored(row.monitored),
                  path: row.path || undefined,
                  folderName: folderName || undefined,
                }),
              );
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
      `Radarr import: ${imported} imported, ${skipped} skipped, ${errors.length} errors`,
    );
    return { imported, skipped, errors };
  }
}
