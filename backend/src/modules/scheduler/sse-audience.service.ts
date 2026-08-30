import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FliksRequest } from '../requests/entities/request.entity';
import { User } from '../users/entities/user.entity';
import { Media } from '../media/entities/media.entity';
import { LibraryUserAccess } from '../libraries/entities/library-user-access.entity';

/**
 * Resolves which users should receive a media-scoped SSE toast (import done,
 * import failed, stalled download removed). The audience is the set of users who
 * requested that media. When a media has no linked requests (e.g. an admin
 * added it manually) the toast falls back to admins so library events are never
 * silently dropped.
 */
@Injectable()
export class SseAudienceService {
  constructor(
    @InjectRepository(FliksRequest)
    private readonly requestRepo: Repository<FliksRequest>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(LibraryUserAccess)
    private readonly accessRepo: Repository<LibraryUserAccess>,
  ) {}

  /**
   * Everyone allowed to open the media's page, for passive state the whole
   * household should see — download progress on a media detail header. Unlike
   * {@link recipientsForMedia} this is not narrowed to the requesters: a user
   * who didn't ask for a title still watches it download.
   */
  async viewersForMedia(mediaId: number | null): Promise<number[]> {
    if (mediaId == null) return this.adminIds();
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['library'],
    });
    const libraryId = media?.library?.id ?? null;
    const users = await this.userRepo.find({
      where: { enabled: true },
      relations: ['userRole'],
    });
    if (libraryId == null) {
      return users.filter((u) => this.hasEveryLibrary(u)).map((u) => u.id);
    }
    const granted = new Set(
      (
        await this.accessRepo.find({ where: { library: { id: libraryId } } })
      ).map((a) => a.userId),
    );
    return users
      .filter((u) => this.hasEveryLibrary(u) || granted.has(u.id))
      .map((u) => u.id);
  }

  /** Same rule as LibrariesService.getAccessibleLibraryIds' fast path. */
  private hasEveryLibrary(user: User): boolean {
    return user.isAdmin || user.permissions.includes('manage:all');
  }

  async recipientsForMedia(mediaId: number | null): Promise<number[]> {
    if (mediaId != null) {
      const requests = await this.requestRepo.find({
        where: { media: { id: mediaId } },
        loadEagerRelations: false,
      });
      const requesterIds = [...new Set(requests.map((r) => r.userId))];
      if (requesterIds.length) return requesterIds;
    }
    return this.adminIds();
  }

  private async adminIds(): Promise<number[]> {
    const admins = await this.userRepo.find({
      where: { isAdmin: true, enabled: true },
      select: { id: true },
    });
    return admins.map((u) => u.id);
  }
}
