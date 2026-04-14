import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import * as fs from 'fs';
import { Library } from './entities/library.entity';
import { LibraryUserAccess } from './entities/library-user-access.entity';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import { Media } from '../media/entities/media.entity';
import { User } from '../users/entities/user.entity';
import { Role } from '../roles/entities/role.entity';
import { QualityProfile } from '../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../profiles/entities/language-profile.entity';
import { CreateLibraryDto } from './dto/create-library.dto';
import { UpdateLibraryDto } from './dto/update-library.dto';
import { AddLibraryPathDto } from './dto/add-library-path.dto';
import { MediaType } from '../../common/enums/media-type.enum';
import { SettingsService } from '../settings/settings.service';

interface RootFolderWithDisk {
  id: number;
  path: string;
  label: string | null;
  freeSpace: number;
  totalSpace: number;
  accessible: boolean;
}

export interface LibraryWithDetails extends Omit<Library, 'rootFolders'> {
  rootFolders: RootFolderWithDisk[];
  userIds: number[];
}

@Injectable()
export class LibrariesService implements OnModuleInit {
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
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    private readonly settings: SettingsService,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.autoWrapLegacyRootFolders();
  }

  // ---------------------------------------------------------------------------
  // Migration: wrap every legacy RootFolder into its own Library on first boot
  // ---------------------------------------------------------------------------

  /**
   * Idempotent. Runs once on first startup after the library feature lands.
   * Skips entirely once at least one Library exists.
   */
  private async autoWrapLegacyRootFolders(): Promise<void> {
    const existing = await this.repo.count();
    if (existing > 0) return;

    // RootFolder.libraryId is a @RelationId virtual; filter by the relation
    // being null (translates to `libraryId IS NULL`).
    const orphanRoots = await this.rootFolderRepo
      .createQueryBuilder('rf')
      .where('rf."libraryId" IS NULL')
      .getMany();
    if (!orphanRoots.length) return;

    this.log.log(
      `Auto-wrapping ${orphanRoots.length} legacy root folder(s) into libraries`,
    );

    await this.dataSource.transaction(async (m) => {
      const libraries: Library[] = [];

      // 1. Create one Library per RootFolder. Defaults only — legacy
      //    per-rootfolder columns (mediaTypes/preferredProvider/cleanup)
      //    have been removed; admin reconfigures via library editor.
      for (const rf of orphanRoots) {
        const lib = m.create(Library, {
          name: rf.label?.trim() || rf.path,
          mediaTypes: [MediaType.MOVIE, MediaType.SERIES],
        });
        const saved = await m.save(lib);
        libraries.push(saved);

        // 2. Link the root folder.
        await m.update(RootFolder, rf.id, {
          library: { id: saved.id } as Library,
        });

        // 3. Bulk-update all media under that root folder.
        //    Use QueryBuilder because both `rootFolderId` (where) and
        //    `libraryId` (set) are virtual relation columns that can't be
        //    expressed via DeepPartial.
        await m
          .createQueryBuilder()
          .update(Media)
          .set({ library: { id: saved.id } as Library })
          .where('"rootFolderId" = :rfId', { rfId: rf.id })
          .execute();
      }

      // 4. Grant every existing user access to every new library.
      const users = await m.find(User);
      const accessRows: LibraryUserAccess[] = [];
      for (const u of users) {
        for (const lib of libraries) {
          accessRows.push(
            m.create(LibraryUserAccess, { user: u, library: lib }),
          );
        }
      }
      if (accessRows.length) await m.save(accessRows);

      // 6. Mirror "everyone sees everything" in the role defaults
      //    (real ManyToMany — sets the junction rows, not a raw id list).
      const roles = await m.find(Role);
      for (const r of roles) {
        r.defaultLibraries = libraries;
        await m.save(r);
      }
    });

    this.log.log('Auto-wrap complete');
  }

  // ---------------------------------------------------------------------------
  // ACL helper
  // ---------------------------------------------------------------------------

  /**
   * Returns the list of library IDs the user can read.
   *  - `null` means "no filter" — admins or users with `manage:all`.
   *  - `[]` means "user has no library access" — caller should return empty.
   *  - non-empty array — apply `WHERE libraryId IN (…)`.
   */
  async getAccessibleLibraryIds(user: User): Promise<number[] | null> {
    if (user.isAdmin || user.permissions.includes('manage:all')) return null;
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
      relations: ['rootFolders'],
    });
    return Promise.all(libs.map((l) => this.enrich(l)));
  }

  async findOne(id: number): Promise<LibraryWithDetails> {
    const lib = await this.repo.findOne({
      where: { id },
      relations: ['rootFolders'],
    });
    if (!lib) throw new NotFoundException(`Library #${id} not found`);
    return this.enrich(lib);
  }

  async create(dto: CreateLibraryDto): Promise<LibraryWithDetails> {
    return this.dataSource.transaction(async (m) => {
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

      // Initial paths.
      for (const p of dto.paths ?? []) {
        await this.attachPath(m, lib.id, { path: p });
      }

      // Initial user access.
      if (dto.userIds?.length) {
        await this.replaceUserAccess(m, lib.id, dto.userIds);
      }

      return this.findOne(lib.id);
    });
  }

  async update(id: number, dto: UpdateLibraryDto): Promise<LibraryWithDetails> {
    return this.dataSource.transaction(async (m) => {
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

      return this.findOne(id);
    });
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
  // Path management
  // ---------------------------------------------------------------------------

  async addPath(
    libraryId: number,
    dto: AddLibraryPathDto,
  ): Promise<RootFolder> {
    return this.dataSource.transaction((m) =>
      this.attachPath(m, libraryId, dto),
    );
  }

  async removePath(libraryId: number, pathId: number): Promise<void> {
    const rf = await this.rootFolderRepo.findOne({ where: { id: pathId } });
    if (!rf || rf.libraryId !== libraryId) {
      throw new NotFoundException(
        `Path #${pathId} not found in library #${libraryId}`,
      );
    }
    const used = await this.mediaRepo.count({
      where: { rootFolder: { id: pathId } },
    });
    if (used > 0) {
      throw new BadRequestException(
        `Path "${rf.path}" still contains ${used} media item(s). Remove or move them before removing the path.`,
      );
    }
    await this.rootFolderRepo.remove(rf);
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
   * Pick the "best" root folder inside the library to drop new media into.
   * Strategy: most free space (spreads data across disks). Falls back to the
   * first root folder if disk info is unavailable on every path.
   */
  async pickRootFolderForLibrary(libraryId: number): Promise<RootFolder> {
    const folders = await this.rootFolderRepo.find({
      where: { library: { id: libraryId } },
    });
    if (!folders.length) {
      throw new BadRequestException(
        `Library #${libraryId} has no root path configured`,
      );
    }
    const ranked = folders
      .map((f) => ({ folder: f, free: this.diskFreeSpace(f.path) }))
      .sort((a, b) => b.free - a.free);
    return ranked[0].folder;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async attachPath(
    m: import('typeorm').EntityManager,
    libraryId: number,
    dto: AddLibraryPathDto,
  ): Promise<RootFolder> {
    const lib = await m.findOne(Library, { where: { id: libraryId } });
    if (!lib) throw new NotFoundException(`Library #${libraryId} not found`);
    if (!fs.existsSync(dto.path)) {
      throw new BadRequestException(
        `Path "${dto.path}" does not exist on the server`,
      );
    }
    const existing = await m.findOne(RootFolder, { where: { path: dto.path } });
    if (existing) {
      if (existing.libraryId === libraryId) return existing;
      throw new BadRequestException(
        `Path "${dto.path}" is already attached to another library`,
      );
    }
    const rf = m.create(RootFolder, {
      path: dto.path,
      label: dto.label,
      library: lib,
    });
    return m.save(rf);
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

  private diskFreeSpace(path: string): number {
    const info = this.diskInfo(path);
    return info.freeSpace < 0 ? 0 : info.freeSpace;
  }

  private async enrich(lib: Library): Promise<LibraryWithDetails> {
    const rootFolders: RootFolderWithDisk[] = (lib.rootFolders ?? []).map(
      (rf) => {
        const disk = this.diskInfo(rf.path);
        return {
          id: rf.id,
          path: rf.path,
          label: rf.label ?? null,
          freeSpace: disk.freeSpace,
          totalSpace: disk.totalSpace,
          accessible: disk.freeSpace !== -1,
        };
      },
    );
    const userIds = await this.getUserAccess(lib.id);
    return { ...lib, rootFolders, userIds };
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
   * Resolves a target library for Radarr/Sonarr import flows.
   *  - Existing library id wins (validates media type).
   *  - Otherwise creates a new library with the requested name.
   *  - Otherwise creates a library with `autoLabel` ("Radarr Import …").
   */
  async resolveTargetLibrary(opts: {
    targetLibraryId?: number;
    newLibraryName?: string;
    mediaType: MediaType;
    autoLabel: string;
  }): Promise<Library> {
    if (opts.targetLibraryId && opts.newLibraryName) {
      throw new BadRequestException(
        'Specify either targetLibraryId or newLibraryName, not both',
      );
    }

    if (opts.targetLibraryId) {
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

    const name = (opts.newLibraryName ?? opts.autoLabel).trim();
    if (!name) throw new BadRequestException('Library name is required');

    return this.dataSource.transaction(async (m) => {
      const lib = await m.save(
        m.create(Library, {
          name,
          mediaTypes: [opts.mediaType],
        }),
      );
      // Seed access via existing role defaults (mirrors regular library creation).
      // Load the relation so we can append rather than replacing it.
      const roles = await m.find(Role, { relations: ['defaultLibraries'] });
      for (const r of roles) {
        r.defaultLibraries = [...(r.defaultLibraries ?? []), lib];
        await m.save(r);
      }
      return lib;
    });
  }
}
