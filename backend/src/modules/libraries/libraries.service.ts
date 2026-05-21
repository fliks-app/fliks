import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import * as fs from 'fs';
import { Library } from './entities/library.entity';
import { LibraryUserAccess } from './entities/library-user-access.entity';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import { Media } from '../media/entities/media.entity';
import { User } from '../users/entities/user.entity';
import { QualityProfile } from '../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../profiles/entities/language-profile.entity';
import { CreateLibraryDto } from './dto/create-library.dto';
import { UpdateLibraryDto } from './dto/update-library.dto';
import { MediaType } from '../../common/enums/media-type.enum';

interface RootFolderWithDisk {
  id: number;
  path: string;
  label: string | null;
  freeSpace: number;
  totalSpace: number;
  accessible: boolean;
}

export interface LibraryWithDetails extends Omit<Library, 'rootFolder'> {
  rootFolder: RootFolderWithDisk | null;
  userIds: number[];
}

@Injectable()
export class LibrariesService {
  private readonly log = new Logger(LibrariesService.name);

  constructor(
    @InjectRepository(Library)
    private readonly repo: Repository<Library>,
    @InjectRepository(LibraryUserAccess)
    private readonly accessRepo: Repository<LibraryUserAccess>,
    @InjectRepository(RootFolder)
    private readonly rootFolderRepo: Repository<RootFolder>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    private readonly dataSource: DataSource,
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
      relations: ['rootFolder'],
    });
    return Promise.all(libs.map((l) => this.enrich(l)));
  }

  async findOne(id: number): Promise<LibraryWithDetails> {
    const lib = await this.repo.findOne({
      where: { id },
      relations: ['rootFolder'],
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
          stalledCleanupProfile: dto.stalledCleanupProfile ?? null,
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

      // Initial path (singleton — at most one root folder per library).
      if (dto.path) {
        await this.attachPath(m, lib.id, dto.path);
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
      if (dto.stalledCleanupProfile !== undefined)
        patch.stalledCleanupProfile = dto.stalledCleanupProfile;
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

      // Singleton path: replace, attach, or leave untouched depending on
      // the incoming value. `undefined` = no change; an empty string clears
      // the path; any non-empty value either replaces an existing folder
      // (same path = no-op) or creates the first one.
      if (dto.path !== undefined) {
        await this.replacePath(m, id, dto.path);
      }
    });
    return this.findOne(id);
  }

  async remove(id: number): Promise<void> {
    const lib = await this.repo.findOne({ where: { id } });
    if (!lib) throw new NotFoundException(`Library #${id} not found`);
    const mediaCount = await this.mediaRepo.count({
      where: { library: { id } },
    });
    if (mediaCount > 0) {
      throw new BadRequestException(
        `Library still contains ${mediaCount} media item(s). Remove all media before deleting the library.`,
      );
    }
    // Cascade handles root_folders + library_user_access.
    await this.repo.remove(lib);
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
   * Look up the singleton root folder for a library. Throws if the library
   * has no path configured yet (admin must set one before adding media).
   */
  async getRootFolder(libraryId: number): Promise<RootFolder> {
    const rf = await this.rootFolderRepo.findOne({
      where: { library: { id: libraryId } },
    });
    if (!rf) {
      throw new BadRequestException(
        `Library #${libraryId} has no root path configured`,
      );
    }
    return rf;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async attachPath(
    m: import('typeorm').EntityManager,
    libraryId: number,
    path: string,
    label?: string,
  ): Promise<RootFolder> {
    const lib = await m.findOne(Library, { where: { id: libraryId } });
    if (!lib) throw new NotFoundException(`Library #${libraryId} not found`);
    if (!fs.existsSync(path)) {
      throw new BadRequestException(
        `Path "${path}" does not exist on the server`,
      );
    }
    const existing = await m.findOne(RootFolder, { where: { path } });
    if (existing) {
      if (existing.libraryId === libraryId) return existing;
      throw new BadRequestException(
        `Path "${path}" is already attached to another library`,
      );
    }
    const rf = m.create(RootFolder, {
      path,
      label: label ?? undefined,
      library: lib,
    });
    return m.save(rf);
  }

  /**
   * Replace the library's singleton root folder. An empty string clears
   * it (only allowed if no media still anchors there); a non-empty path
   * either no-ops (same path), updates the existing row in place, or
   * creates a brand new one. Detaching by switching to a different path
   * is blocked while media still anchor on the previous one — admin
   * must move/remove the media first.
   */
  private async replacePath(
    m: import('typeorm').EntityManager,
    libraryId: number,
    nextPath: string,
  ): Promise<void> {
    const current = await m.findOne(RootFolder, {
      where: { library: { id: libraryId } },
    });
    const trimmed = nextPath.trim();
    if (!trimmed) {
      if (!current) return;
      const used = await m.count(Media, {
        where: { rootFolder: { id: current.id } },
      });
      if (used > 0) {
        throw new BadRequestException(
          `Path "${current.path}" still contains ${used} media item(s).`,
        );
      }
      await m.remove(current);
      return;
    }
    if (current && current.path === trimmed) return;
    if (current) {
      const used = await m.count(Media, {
        where: { rootFolder: { id: current.id } },
      });
      if (used > 0) {
        throw new BadRequestException(
          `Path "${current.path}" still contains ${used} media item(s) — cannot change the library's root path.`,
        );
      }
      await m.remove(current);
    }
    await this.attachPath(m, libraryId, trimmed);
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

  private diskInfo(path: string): { freeSpace: number; totalSpace: number } {
    try {
      const stats = fs.statfsSync(path);
      return {
        freeSpace: Number(stats.bfree) * Number(stats.bsize),
        totalSpace: Number(stats.blocks) * Number(stats.bsize),
      };
    } catch {
      return { freeSpace: -1, totalSpace: -1 };
    }
  }

  private async enrich(lib: Library): Promise<LibraryWithDetails> {
    let rootFolder: RootFolderWithDisk | null = null;
    if (lib.rootFolder) {
      const disk = this.diskInfo(lib.rootFolder.path);
      rootFolder = {
        id: lib.rootFolder.id,
        path: lib.rootFolder.path,
        label: lib.rootFolder.label ?? null,
        freeSpace: disk.freeSpace,
        totalSpace: disk.totalSpace,
        accessible: disk.freeSpace !== -1,
      };
    }
    const userIds = await this.getUserAccess(lib.id);
    return { ...lib, rootFolder, userIds };
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
