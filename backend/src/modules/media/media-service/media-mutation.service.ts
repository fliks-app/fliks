import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { promises as fsp } from 'fs';
import * as nodePath from 'path';
import { Media } from '../entities/media.entity';
import { MediaFile } from '../entities/media-file.entity';
import { Season } from '../entities/season.entity';
import { Episode } from '../entities/episode.entity';
import { UpdateMediaDto } from '../dto/update-media.dto';
import { UpdateMediaProfilesDto } from '../dto/update-media-profiles.dto';
import { BulkUpdateMediaDto } from '../dto/bulk-update-media.dto';
import { ProfilesService } from '../../profiles/profiles.service';
import { QualityProfile } from '../../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../../profiles/entities/language-profile.entity';
import { Library } from '../../libraries/entities/library.entity';
import { MediaServersService } from '../../media-servers/media-servers.service';
import { EventsService } from '../../scheduler/events.service';
import { RequestLifecycleService } from '../../requests/request-lifecycle.service';
import { MediaQueryService } from './media-query.service';
import { MediaMetadataService } from './media-metadata.service';
import { ThumbnailService } from '../../streaming/thumbnail.service';

@Injectable()
export class MediaMutationService {
  private readonly log = new Logger(MediaMutationService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(Library)
    private readonly libraryRepo: Repository<Library>,
    private readonly profiles: ProfilesService,
    private readonly mediaServers: MediaServersService,
    private readonly query: MediaQueryService,
    private readonly metadata: MediaMetadataService,
    @Inject(forwardRef(() => RequestLifecycleService))
    private readonly requestLifecycle: RequestLifecycleService,
    private readonly events: EventsService,
    private readonly thumbnails: ThumbnailService,
  ) {}

  async update(id: number, dto: UpdateMediaDto): Promise<Media> {
    const media = await this.query.findOne(id);
    const wasMonitored = media.monitored;
    const { path: _path, ...rest } = dto;

    Object.assign(media, rest);

    const saved = await this.mediaRepo.save(media);
    if (dto.monitored !== undefined) {
      await this.cascadeMonitoredToChildren([saved.id], dto.monitored);
      this.events.emitDomain({
        type: 'media.monitored.changed',
        mediaId: saved.id,
        monitored: dto.monitored,
      });
    }
    await this.metadata.updateSearchVector(saved.id);
    await this.requestLifecycle.onMediaMonitorChange(saved, wasMonitored);
    return this.query.findOne(saved.id);
  }

  /**
   * Propagate a series' monitored flag down to every season and episode it
   * owns. Toggling monitoring on a series (or season) is an all-or-nothing
   * intent: the children inherit the new state so the library doesn't keep
   * grabbing episodes under an unmonitored series. A no-op for movies, which
   * own no seasons. Plain bulk UPDATEs keep it to two statements regardless of
   * how many episodes the series has.
   */
  private async cascadeMonitoredToChildren(
    mediaIds: number[],
    monitored: boolean,
  ): Promise<void> {
    if (mediaIds.length === 0) return;
    await this.seasonRepo
      .createQueryBuilder()
      .update(Season)
      .set({ monitored })
      .where('"mediaId" IN (:...mediaIds)', { mediaIds })
      .execute();
    await this.episodeRepo
      .createQueryBuilder()
      .update(Episode)
      .set({ monitored })
      .where(
        '"seasonId" IN (SELECT id FROM seasons WHERE "mediaId" IN (:...mediaIds))',
        { mediaIds },
      )
      .execute();
  }

  /**
   * Reassign media to a different library. Picks a root folder inside the
   * target library (most free space) and updates both FKs atomically.
   */
  async updateLibrary(id: number, libraryId: number): Promise<Media> {
    await this.query.findOne(id);
    const library = await this.libraryRepo.findOne({
      where: { id: libraryId },
    });
    if (!library) {
      throw new NotFoundException(`Library #${libraryId} not found`);
    }
    if (!library.path) {
      throw new BadRequestException(
        `Library "${library.name}" has no root path configured`,
      );
    }
    await this.mediaRepo.update(id, { library });
    return this.query.findOne(id);
  }

  async updateProfiles(
    id: number,
    dto: UpdateMediaProfilesDto,
  ): Promise<Media> {
    await this.query.findOne(id);
    const patch: {
      qualityProfile?: QualityProfile | null;
      languageProfile?: LanguageProfile | null;
    } = {};
    if (dto.qualityProfileId !== undefined) {
      if (dto.qualityProfileId !== null) {
        await this.profiles.findOneQualityProfile(dto.qualityProfileId);
        patch.qualityProfile = { id: dto.qualityProfileId } as QualityProfile;
      } else {
        patch.qualityProfile = null;
      }
    }
    if (dto.languageProfileId !== undefined) {
      if (dto.languageProfileId !== null) {
        await this.profiles.findOneLanguageProfile(dto.languageProfileId);
        patch.languageProfile = {
          id: dto.languageProfileId,
        } as LanguageProfile;
      } else {
        patch.languageProfile = null;
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException(
        'Provide at least one of qualityProfileId or languageProfileId',
      );
    }
    await this.mediaRepo.update(
      { id },
      patch as Parameters<Repository<Media>['update']>[1],
    );
    return this.query.findOne(id);
  }

  async bulkUpdate(dto: BulkUpdateMediaDto): Promise<{ updated: number }> {
    const patch: Partial<Record<string, unknown>> = {};

    if (dto.qualityProfileId !== undefined) {
      patch.qualityProfile =
        dto.qualityProfileId === null
          ? null
          : ({ id: dto.qualityProfileId } as QualityProfile);
    }
    if (dto.languageProfileId !== undefined) {
      patch.languageProfile =
        dto.languageProfileId === null
          ? null
          : ({ id: dto.languageProfileId } as LanguageProfile);
    }
    if (dto.monitored !== undefined) {
      patch.monitored = dto.monitored;
    }
    if (dto.libraryId !== undefined) {
      patch.libraryId = dto.libraryId;
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('Provide at least one field to update');
    }

    const result = await this.mediaRepo
      .createQueryBuilder()
      .update(Media)
      .set(patch)
      .whereInIds(dto.ids)
      .execute();

    if (dto.monitored !== undefined) {
      await this.cascadeMonitoredToChildren(dto.ids, dto.monitored);
    }

    return { updated: result.affected ?? 0 };
  }

  /**
   * Remove the media's DB records and return the on-disk folder that should be
   * deleted afterwards (or null when there is nothing safe to delete). Disk
   * deletion is left to the caller so it can run after the HTTP response and
   * report a failure back to the initiating client without blocking the UI.
   */
  async remove(id: number): Promise<{ title: string; diskPath: string | null }> {
    const media = await this.query.findOne(id);
    const title = media.title;
    const mediaPath = media.path;
    const tmdbId = media.tmdbId;
    const mediaType = media.type;
    const diskPath = this.resolveSafeMediaDir(media);
    // Sprites live outside the media folder, keyed by file id — the cascade
    // that drops the file rows would strand them.
    const fileIds = (media.files ?? []).map((f) => f.id);
    await this.requestLifecycle.onMediaRemoved(media);
    await this.mediaRepo.remove(media);
    for (const fileId of fileIds) void this.thumbnails.deleteForFile(fileId);
    this.events.emitDomain({
      type: 'media.removed',
      mediaId: id,
      tmdbId: tmdbId ?? null,
      mediaType,
    });
    void this.mediaServers.dispatch('media.deleted', {
      title,
      path: mediaPath,
    });
    return { title, diskPath };
  }

  /**
   * Resolve the media's own folder, guarded to stay strictly inside the library
   * root: it never returns the root itself and rejects a folderName that would
   * escape it (e.g. via '..'). Returns null when there is no folder to delete.
   */
  private resolveSafeMediaDir(media: Media): string | null {
    const root = media.library?.path;
    const dir = media.path;
    if (!root || !dir) return null;

    const resolvedRoot = nodePath.resolve(root);
    const resolvedDir = nodePath.resolve(dir);
    if (
      resolvedDir === resolvedRoot ||
      !resolvedDir.startsWith(resolvedRoot + nodePath.sep)
    ) {
      this.log.warn(
        `Refusing to delete media folder outside library root: ${resolvedDir}`,
      );
      return null;
    }
    return resolvedDir;
  }

  /**
   * Delete a media folder on disk so removing it from the library leaves no
   * orphan video/subtitle/artwork files behind. Tolerates an already-missing
   * folder; throws on any other filesystem error so the caller can notify.
   */
  async deleteMediaFolder(dir: string): Promise<void> {
    await fsp.rm(dir, { recursive: true, force: true });
    this.log.log(`Deleted media folder on disk: ${dir}`);
  }

  async updateSeason(
    seasonId: number,
    patch: { monitored?: boolean; preferredProvider?: 'tmdb' | 'tvdb' | null },
  ): Promise<Season> {
    const season = await this.seasonRepo.findOne({
      where: { id: seasonId },
      relations: ['media'],
    });
    if (!season) throw new NotFoundException(`Season #${seasonId} not found`);
    const wasMonitored = season.monitored;
    if (patch.monitored !== undefined) season.monitored = patch.monitored;
    if (patch.preferredProvider !== undefined)
      season.preferredProvider = patch.preferredProvider;
    const saved = await this.seasonRepo.save(season);
    if (patch.monitored !== undefined) {
      await this.episodeRepo
        .createQueryBuilder()
        .update(Episode)
        .set({ monitored: patch.monitored })
        .where('"seasonId" = :seasonId', { seasonId })
        .execute();
    }
    if (season.media) {
      await this.requestLifecycle.onSeasonMonitorChange(
        season.media,
        saved.seasonNumber,
        wasMonitored,
        saved.monitored,
      );
      this.events.emitDomain({
        type: 'media.season.monitored.changed',
        mediaId: season.media.id,
        seasonNumber: saved.seasonNumber,
        monitored: saved.monitored,
      });
    }
    return saved;
  }

  async updateEpisodeMonitored(
    episodeId: number,
    monitored: boolean,
  ): Promise<Episode> {
    const episode = await this.episodeRepo.findOne({
      where: { id: episodeId },
    });
    if (!episode)
      throw new NotFoundException(`Episode #${episodeId} not found`);
    episode.monitored = monitored;
    return this.episodeRepo.save(episode);
  }

  async deleteMediaFile(
    mediaId: number,
    fileId: number,
    deleteOnDisk: boolean,
  ): Promise<void> {
    const media = await this.mediaRepo.findOne({ where: { id: mediaId } });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);

    const file = await this.mediaFileRepo.findOne({
      where: { id: fileId, media: { id: mediaId } },
    });
    if (!file) throw new NotFoundException(`File #${fileId} not found`);

    if (deleteOnDisk && media.path) {
      const fs = await import('fs');
      const path = await import('path');
      const fullPath = path.join(media.path, file.relativePath);
      try {
        fs.unlinkSync(fullPath);
        this.log.log(`Deleted file on disk: ${fullPath}`);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw err;
        this.log.warn(`File not found on disk (already deleted?): ${fullPath}`);
      }
    }

    const episodeId = file.episodeId;
    await this.mediaFileRepo.remove(file);
    void this.thumbnails.deleteForFile(file.id);
    if (episodeId != null) {
      const remaining = await this.mediaFileRepo.count({
        where: { episode: { id: episodeId } },
      });
      if (remaining === 0) {
        await this.episodeRepo.update(episodeId, { hasFile: false });
      }
    }

    void this.mediaServers.dispatch('file.deleted', {
      title: media.title,
      path: media.path,
    });
  }
}
