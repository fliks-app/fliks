import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Library } from './entities/library.entity';
import { LibraryUserAccess } from './entities/library-user-access.entity';
import { Media } from '../media/entities/media.entity';
import type { MediaService } from '../media/media.service';
import { MEDIA_SERVICE } from '../media/media-service.token';
import { User } from '../users/entities/user.entity';
import { MediaType } from '../../common/enums/media-type.enum';

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

  // Used by other modules wanting to filter on "is it the default lib for X type"
  /** Libraries accepting `type`, narrowed to what `user` may reach when given. */
  async findAccepting(type: MediaType, user?: User): Promise<Library[]> {
    const ids = user ? await this.getAccessibleLibraryIds(user) : null;
    const libs = await this.repo.find({
      where: ids ? { id: In(ids.length ? ids : [-1]) } : {},
      order: { name: 'ASC' },
    });
    return libs.filter((l) => l.mediaTypes?.includes(type));
  }

  /**
   * Destination for a caller that named none. Exactly one candidate answers
   * for itself; anything else is the caller's choice to make, and guessing it
   * here is what the removed default-library flags used to do.
   */
  async resolveSoleLibrary(type: MediaType, user?: User): Promise<Library> {
    const candidates = await this.findAccepting(type, user);
    if (candidates.length === 1) return candidates[0];
    throw new BadRequestException(
      candidates.length
        ? `Several libraries accept ${type} — pass libraryId to choose one`
        : `No library accepts ${type}`,
    );
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
