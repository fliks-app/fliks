import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import * as fs from 'fs';
import { Library } from './entities/library.entity';
import { LibraryUserAccess } from './entities/library-user-access.entity';
import { Media } from '../media/entities/media.entity';
import type { MediaService } from '../media/media.service';
import { MEDIA_SERVICE } from '../media/media-service.token';
import { User } from '../users/entities/user.entity';
import { QualityProfile } from '../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../profiles/entities/language-profile.entity';
import { CreateLibraryDto } from './dto/create-library.dto';
import { UpdateLibraryDto } from './dto/update-library.dto';
import { MediaType } from '../../common/enums/media-type.enum';
import { sanitizeFsPath } from '../../common/utils/fs-path.util';

interface DiskMetrics {
  freeSpace: number;
  totalSpace: number;
  accessible: boolean;
}

export type LibraryWithDetails = Library & {
  userIds: number[];
  disk: DiskMetrics | null;
};

@Injectable()
export class LibrariesService {
  private readonly log = new Logger(LibrariesService.name);

  constructor(
    @InjectRepository(Library)
    private readonly repo: Repository<Library>,
    @InjectRepository(LibraryUserAccess)
    private readonly accessRepo: Repository<LibraryUserAccess>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    private readonly dataSource: DataSource,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ---------------------------------------------------------------------------
  // ACL helper
  // ---------------------------------------------------------------------------

  /**
   * Returns the list of library IDs the user can read. Always concrete —
   * admins / `manage:all` get every existing library ID (resolved at call
   * time, so libraries added after login show up immediately). `[]` means
   * the user has no library access at all and the caller should return
   * empty without further work.
   */
  async getAccessibleLibraryIds(user: User): Promise<number[]> {
    if (user.isAdmin || user.permissions.includes('manage:all')) {
      const rows = await this.repo.find({ select: ['id'] });
      return rows.map((r) => r.id);
    }
    // libraryId is @RelationId — TypeORM auto-populates it without loading the
    // related Library entity.
    const rows = await this.accessRepo.find({
      where: { user: { id: user.id } },
    });
    return rows.map((r) => r.libraryId);
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  /** Lightweight projection for non-admin users (sidebar, route resolution). */
  async findAccessibleSummaries(
    user: User,
  ): Promise<
    Pick<
      Library,
      'id' | 'name' | 'mediaTypes' | 'isDefaultForMovies' | 'isDefaultForSeries'
    >[]
  > {
    const accessible = await this.getAccessibleLibraryIds(user);
    const where =
      accessible == null
        ? {}
        : { id: In(accessible.length ? accessible : [-1]) };
    return this.repo.find({
      where,
      order: { name: 'ASC' },
      select: [
        'id',
        'name',
        'icon',
        'color',
        'mediaTypes',
        'isDefaultForMovies',
        'isDefaultForSeries',
      ],
    });
  }

  async findAllForUser(user: User): Promise<LibraryWithDetails[]> {
    const accessible = await this.getAccessibleLibraryIds(user);
    const where =
      accessible == null
        ? {}
        : { id: In(accessible.length ? accessible : [-1]) };
    const libs = await this.repo.find({
      where,
      order: { name: 'ASC' },
      // path/label live directly on Library — no relation to load.
    });
    return Promise.all(libs.map((l) => this.enrich(l)));
  }

  async findOne(id: number): Promise<LibraryWithDetails> {
    const lib = await this.repo.findOne({
      where: { id },
      // path/label live directly on Library — no relation to load.
    });
    if (!lib) throw new NotFoundException(`Library #${id} not found`);
    return this.enrich(lib);
  }

  async create(dto: CreateLibraryDto): Promise<LibraryWithDetails> {
    // findOne() reads through this.repo (DataSource-level), which under
    // READ COMMITTED can't see writes from an open transaction on another
    // connection — calling it inside the transaction returned null and
    // threw "Library #X not found". Run the writes in the tx, then resolve
    // the enriched view from the committed state.
    const id = await this.dataSource.transaction(async (m) => {
      // Enforce at-most-one default per type.
      if (dto.isDefaultForMovies)
        await this.clearDefaultFlag(m, 'isDefaultForMovies');
      if (dto.isDefaultForSeries)
        await this.clearDefaultFlag(m, 'isDefaultForSeries');

      const lib = await m.save(
        m.create(Library, {
          name: dto.name,
          icon: dto.icon ?? null,
          color: dto.color ?? null,
          mediaTypes: dto.mediaTypes ?? [MediaType.MOVIE, MediaType.SERIES],
          preferredProvider: dto.preferredProvider ?? null,
          metadataLanguage: dto.metadataLanguage || null,
          metadataRegion: dto.metadataRegion || null,
          defaultQualityProfile: dto.defaultQualityProfileId
            ? ({ id: dto.defaultQualityProfileId } as QualityProfile)
            : null,
          defaultLanguageProfile: dto.defaultLanguageProfileId
            ? ({ id: dto.defaultLanguageProfileId } as LanguageProfile)
            : null,
          isDefaultForMovies: dto.isDefaultForMovies ?? false,
          isDefaultForSeries: dto.isDefaultForSeries ?? false,
        }),
      );

      // Initial path validation + write — must exist on disk and be
      // exclusive to one library.
      if (dto.path) {
        await this.assignPath(m, lib.id, dto.path);
      }

      // Initial user access.
      if (dto.userIds?.length) {
        await this.replaceUserAccess(m, lib.id, dto.userIds);
      }

      return lib.id;
    });
    return this.findOne(id);
  }

  async update(id: number, dto: UpdateLibraryDto): Promise<LibraryWithDetails> {
    await this.dataSource.transaction(async (m) => {
      const lib = await m.findOne(Library, { where: { id } });
      if (!lib) throw new NotFoundException(`Library #${id} not found`);

      if (dto.isDefaultForMovies === true) {
        await this.clearDefaultFlag(m, 'isDefaultForMovies');
      }
      if (dto.isDefaultForSeries === true) {
        await this.clearDefaultFlag(m, 'isDefaultForSeries');
      }

      const patch: Partial<Library> = {};
      if (dto.name !== undefined) patch.name = dto.name;
      if (dto.icon !== undefined) patch.icon = dto.icon;
      if (dto.color !== undefined) patch.color = dto.color;
      if (dto.mediaTypes !== undefined) patch.mediaTypes = dto.mediaTypes;
      if (dto.preferredProvider !== undefined)
        patch.preferredProvider = dto.preferredProvider;
      // Empty string from the UI clears the override (inherit the global).
      if (dto.metadataLanguage !== undefined)
        patch.metadataLanguage = dto.metadataLanguage || null;
      if (dto.metadataRegion !== undefined)
        patch.metadataRegion = dto.metadataRegion || null;
      if (dto.defaultQualityProfileId !== undefined) {
        patch.defaultQualityProfile = dto.defaultQualityProfileId
          ? ({ id: dto.defaultQualityProfileId } as QualityProfile)
          : null;
      }
      if (dto.defaultLanguageProfileId !== undefined) {
        patch.defaultLanguageProfile = dto.defaultLanguageProfileId
          ? ({ id: dto.defaultLanguageProfileId } as LanguageProfile)
          : null;
      }
      if (dto.isDefaultForMovies !== undefined)
        patch.isDefaultForMovies = dto.isDefaultForMovies;
      if (dto.isDefaultForSeries !== undefined)
        patch.isDefaultForSeries = dto.isDefaultForSeries;
      if (Object.keys(patch).length) await m.update(Library, id, patch);

      // Replace the path column. `undefined` = no change; an empty string
      // clears it (only if no media still anchors there); any non-empty
      // path either no-ops (same value), or replaces in place.
      if (dto.path !== undefined) {
        await this.assignPath(m, id, dto.path);
      }
    });
    return this.findOne(id);
  }

  /** Resolved lazily, at call time: a DI edge here would close a module cycle
   *  back through the media module. */
  private mediaService(): MediaService {
    return this.moduleRef.get<MediaService>(MEDIA_SERVICE, { strict: false });
  }

  /**
   * Drop the library and every DB row that hung off it. Files on disk are
   * kept: `MediaService.remove` returns the folder for the caller to delete
   * and we deliberately ignore it.
   */
  async remove(id: number): Promise<void> {
    const lib = await this.repo.findOne({ where: { id } });
    if (!lib) throw new NotFoundException(`Library #${id} not found`);

    const media = await this.mediaRepo.find({
      where: { library: { id } },
      select: ['id'],
    });
    for (const m of media) {
      await this.mediaService().remove(m.id);
    }

    // Cascade handles library_user_access; path lives on the row itself.
    await this.repo.remove(lib);
    this.log.log(
      `Library #${id} deleted — ${media.length} media row(s) removed, files kept`,
    );
  }

  // ---------------------------------------------------------------------------
  // User access management
  // ---------------------------------------------------------------------------

  async getUserAccess(libraryId: number): Promise<number[]> {
    const rows = await this.accessRepo.find({
      where: { library: { id: libraryId } },
    });
    return rows.map((r) => r.userId);
  }

  async setUserAccess(libraryId: number, userIds: number[]): Promise<void> {
    await this.dataSource.transaction((m) =>
      this.replaceUserAccess(m, libraryId, userIds),
    );
  }

  /**
   * Look up a library by id. Throws if the library has no path configured
   * yet (admin must set one before adding media or accepting imports).
   */
  async requirePathFor(libraryId: number): Promise<Library> {
    const lib = await this.repo.findOne({ where: { id: libraryId } });
    if (!lib) {
      throw new NotFoundException(`Library #${libraryId} not found`);
    }
    if (!lib.path) {
      throw new BadRequestException(
        `Library #${libraryId} has no root path configured`,
      );
    }
    return lib;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Write `path` on the library row. Empty string clears it (rejected if
   * media still anchors there). Non-empty path: must exist on disk and be
   * exclusive to one library. No-op when the value matches the current row.
   */
  private async assignPath(
    m: import('typeorm').EntityManager,
    libraryId: number,
    rawPath: string,
  ): Promise<void> {
    const lib = await m.findOne(Library, { where: { id: libraryId } });
    if (!lib) throw new NotFoundException(`Library #${libraryId} not found`);
    const trimmed = sanitizeFsPath(rawPath);

    if (!trimmed) {
      if (!lib.path) return;
      const used = await m.count(Media, {
        where: { library: { id: libraryId } },
      });
      if (used > 0) {
        throw new BadRequestException(
          `Path "${lib.path}" still contains ${used} media item(s).`,
        );
      }
      await m.update(Library, libraryId, { path: null });
      return;
    }

    if (lib.path === trimmed) return;

    if (!fs.existsSync(trimmed)) {
      try {
        await fs.promises.mkdir(trimmed, { recursive: true });
      } catch (err) {
        throw new BadRequestException(
          `Path "${trimmed}" could not be created on the server: ${
            (err as Error).message
          }`,
        );
      }
    }
    const conflict = await m.findOne(Library, { where: { path: trimmed } });
    if (conflict && conflict.id !== libraryId) {
      throw new BadRequestException(
        `Path "${trimmed}" is already attached to another library`,
      );
    }
    if (lib.path && lib.path !== trimmed) {
      const used = await m.count(Media, {
        where: { library: { id: libraryId } },
      });
      if (used > 0) {
        throw new BadRequestException(
          `Path "${lib.path}" still contains ${used} media item(s) — cannot change the library's root path.`,
        );
      }
    }
    await m.update(Library, libraryId, { path: trimmed });
  }

  private async replaceUserAccess(
    m: import('typeorm').EntityManager,
    libraryId: number,
    userIds: number[],
  ): Promise<void> {
    await m.delete(LibraryUserAccess, { library: { id: libraryId } });
    if (!userIds.length) return;
    const rows = userIds.map((uid) =>
      m.create(LibraryUserAccess, {
        library: { id: libraryId } as Library,
        user: { id: uid } as User,
      }),
    );
    await m.save(rows);
  }

  private async clearDefaultFlag(
    m: import('typeorm').EntityManager,
    flag: 'isDefaultForMovies' | 'isDefaultForSeries',
  ): Promise<void> {
    await m.update(Library, { [flag]: true }, { [flag]: false });
  }

  /** Async on purpose: a statfs on a slow network mount would otherwise
   *  block the event loop for every other request. */
  private async diskInfo(
    path: string,
  ): Promise<{ freeSpace: number; totalSpace: number }> {
    try {
      const stats = await fs.promises.statfs(path);
      return {
        freeSpace: Number(stats.bfree) * Number(stats.bsize),
        totalSpace: Number(stats.blocks) * Number(stats.bsize),
      };
    } catch {
      return { freeSpace: -1, totalSpace: -1 };
    }
  }

  private async enrich(lib: Library): Promise<LibraryWithDetails> {
    const [info, userIds] = await Promise.all([
      lib.path ? this.diskInfo(lib.path) : null,
      this.getUserAccess(lib.id),
    ]);
    const disk: DiskMetrics | null = info
      ? {
          freeSpace: info.freeSpace,
          totalSpace: info.totalSpace,
          accessible: info.freeSpace !== -1,
        }
      : null;
    return { ...lib, disk, userIds };
  }

  // Used by other modules wanting to filter on "is it the default lib for X type"
  async getDefaultForType(type: MediaType): Promise<Library | null> {
    const where =
      type === MediaType.MOVIE
        ? { isDefaultForMovies: true }
        : { isDefaultForSeries: true };
    return this.repo.findOne({ where });
  }

  /**
   * Validates a target library for Radarr/Sonarr import flows: the library
   * must exist and accept the imported media type.
   */
  async resolveTargetLibrary(opts: {
    targetLibraryId: number;
    mediaType: MediaType;
  }): Promise<Library> {
    const lib = await this.repo.findOne({
      where: { id: opts.targetLibraryId },
    });
    if (!lib) {
      throw new BadRequestException(
        `Library #${opts.targetLibraryId} not found`,
      );
    }
    if (!lib.mediaTypes?.includes(opts.mediaType)) {
      throw new BadRequestException(
        `Library "${lib.name}" does not accept ${opts.mediaType}`,
      );
    }
    return lib;
  }
}
