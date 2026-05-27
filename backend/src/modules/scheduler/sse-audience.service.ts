import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FliksRequest } from '../requests/entities/request.entity';
import { User } from '../users/entities/user.entity';

/**
 * Resolves which users should receive a media-scoped SSE toast (import done,
 * import failed, stalled torrent removed). The audience is the set of users who
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
  ) {}

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
