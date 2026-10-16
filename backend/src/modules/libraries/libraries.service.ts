import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Library } from './entities/library.entity';
import { LibraryUserAccess } from './entities/library-user-access.entity';
import { Media } from '../media/entities/media.entity';
import { User } from '../users/entities/user.entity';

/**
 * Library ACL reads for the Nest code that stays until S8 (counts, plugin guards, live TV).
 * Libraries themselves are served by fliks-server.
 */
@Injectable()
export class LibrariesService {
  constructor(
    @InjectRepository(Library)
    private readonly repo: Repository<Library>,
    @InjectRepository(LibraryUserAccess)
    private readonly accessRepo: Repository<LibraryUserAccess>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
  ) {}

  /**
   * The library ids the user can read; admins and `manage:all` get every library.
   * `[]` means no access at all.
   */
  async getAccessibleLibraryIds(user: User): Promise<number[]> {
    if (user.isAdmin || user.permissions.includes('manage:all')) {
      const rows = await this.repo.find({ select: ['id'] });
      return rows.map((r) => r.id);
    }
    const rows = await this.accessRepo.find({
      where: { user: { id: user.id } },
    });
    return rows.map((r) => r.libraryId);
  }

  /** 404 for a media outside the accessible libraries, like an unknown one. */
  async assertMediaAccessible(
    mediaId: number,
    accessibleLibraryIds: number[],
  ): Promise<void> {
    const row = await this.mediaRepo
      .createQueryBuilder('m')
      .select('m."libraryId"', 'libraryId')
      .where('m.id = :mediaId', { mediaId })
      .getRawOne<{ libraryId: number | null }>();
    if (
      !row ||
      row.libraryId == null ||
      !accessibleLibraryIds.includes(row.libraryId)
    ) {
      throw new NotFoundException(`Media #${mediaId} not found`);
    }
  }

  async getCountsByLibrary(
    accessibleLibraryIds: number[],
  ): Promise<Record<number, number>> {
    const rows: { libraryId: number; count: number }[] = await this.mediaRepo
      .createQueryBuilder('m')
      .select('m."libraryId"', 'libraryId')
      .addSelect('COUNT(*)::int', 'count')
      .where('m."libraryId" = ANY(:ids)', { ids: accessibleLibraryIds })
      .groupBy('m."libraryId"')
      .getRawMany();
    return Object.fromEntries(rows.map((r) => [r.libraryId, r.count]));
  }
}
