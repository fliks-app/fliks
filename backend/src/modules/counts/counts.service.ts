import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DownloadHistory } from '../media/entities/download-history.entity';
import { FliksRequest } from '../requests/entities/request.entity';
import { DownloadClient } from '../../plugins/download/download-clients/entities/download-client.entity';
import { Media } from '../media/entities/media.entity';
import { User } from '../users/entities/user.entity';
import { RequestStatus } from '../../common/enums';
import {
  AppAbility,
  CaslAbilityFactory,
} from '../auth/casl/casl-ability.factory';
import { Action } from '../auth/casl/actions.enum';
import { MediaService } from '../media/media.service';
import { LibrariesService } from '../libraries/libraries.service';

export interface SidebarCounts {
  queueActive: number;
  pendingRequests: number;
  mediaByLibrary: Record<number, number>;
}

/**
 * Aggregated badge counts for the app shell, in one round-trip. Every count
 * is a plain DB aggregate — in particular the queue count reads the download
 * history instead of fanning out to the live download clients, which is what
 * makes this endpoint cheap enough to refresh on every SSE event.
 */
@Injectable()
export class CountsService {
  constructor(
    @InjectRepository(DownloadHistory)
    private readonly historyRepo: Repository<DownloadHistory>,
    @InjectRepository(FliksRequest)
    private readonly requestRepo: Repository<FliksRequest>,
    private readonly caslAbilityFactory: CaslAbilityFactory,
    private readonly mediaService: MediaService,
    private readonly libraries: LibrariesService,
  ) {}

  async getCounts(user: User): Promise<SidebarCounts> {
    const ability = this.caslAbilityFactory.createForUser(user);
    const [queueActive, pendingRequests, mediaByLibrary] = await Promise.all([
      this.countActiveQueue(ability),
      this.countPendingRequests(user, ability),
      this.countMediaByLibrary(user, ability),
    ]);
    return { queueActive, pendingRequests, mediaByLibrary };
  }

  /**
   * Downloads still doing work, from the history table. `grabbed` and
   * `importing` are the states the queue badge counts; `warning`, `failed`
   * and `completed` are excluded from the badge.
   *
   * Known drift vs the live queue, accepted in exchange for skipping the
   * client fan-out (the badge links to the queue page, where truth lives):
   * - client-side error states (tracker error, missing files) and torrents
   *   removed from the client stay counted until the orphan reaper flips
   *   the row to `failed` (~30 min grace);
   * - a row stuck in `importing` by a mid-import crash is counted until it
   *   reaches a terminal status;
   * - torrents living in the download client without a history row
   *   (added outside the app) are not counted at all.
   */
  private async countActiveQueue(ability: AppAbility): Promise<number> {
    if (!ability.can(Action.Read, DownloadClient)) return 0;
    return this.historyRepo.count({
      where: { status: In(['grabbed', 'importing']) },
    });
  }

  /** Same scoping as RequestsService.findAll: managers count everything,
   *  other users count their own pending requests. */
  private async countPendingRequests(
    user: User,
    ability: AppAbility,
  ): Promise<number> {
    const canManage = ability.can(Action.Manage, FliksRequest);
    // userId is a @RelationId (not a queryable column) — scope through the
    // relation instead.
    return this.requestRepo.count({
      where: {
        status: RequestStatus.PENDING,
        ...(canManage ? {} : { user: { id: user.id } }),
      },
    });
  }

  /** Mirrors the gating of GET /media/counts-by-library: media.read
   *  required, then scoped to the user's accessible libraries. */
  private async countMediaByLibrary(
    user: User,
    ability: AppAbility,
  ): Promise<Record<number, number>> {
    if (!ability.can(Action.Read, Media)) return {};
    const accessibleLibraryIds =
      await this.libraries.getAccessibleLibraryIds(user);
    return this.mediaService.getCountsByLibrary(accessibleLibraryIds);
  }
}
