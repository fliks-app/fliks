import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FliksRequest } from '../requests/entities/request.entity';
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
import { PluginCountsCacheService } from '../plugins/host/plugin-counts-cache.service';

export interface SidebarCounts {
  /** Keyed by a nav contribution's `badge` (e.g. `queueActive`); a key a
   *  publisher never pushed is absent, never present-and-0. */
  badgeCounts: Record<string, number>;
  pendingRequests: number;
  mediaByLibrary: Record<number, number>;
}

/** Aggregated badge counts for the app shell, in one round-trip. `badgeCounts`
 *  holds whatever a plugin last pushed via `counts.set`, gated per key by the
 *  same audience as the surface it feeds — never a query against its tables. */
@Injectable()
export class CountsService {
  constructor(
    @InjectRepository(FliksRequest)
    private readonly requestRepo: Repository<FliksRequest>,
    private readonly caslAbilityFactory: CaslAbilityFactory,
    private readonly mediaService: MediaService,
    private readonly libraries: LibrariesService,
    private readonly pluginCounts: PluginCountsCacheService,
  ) {}

  async getCounts(user: User): Promise<SidebarCounts> {
    const ability = this.caslAbilityFactory.createForUser(user);
    const [pendingRequests, mediaByLibrary] = await Promise.all([
      this.countPendingRequests(user, ability),
      this.countMediaByLibrary(user, ability),
    ]);
    return {
      badgeCounts: this.readBadgeCounts(ability),
      pendingRequests,
      mediaByLibrary,
    };
  }

  /** Same audience as the queue itself: settings managers, plus the users the
   *  client seeds progress for. Absent — not 0 — for anyone else, or if no
   *  publisher ever pushed a value. */
  private readBadgeCounts(ability: AppAbility): Record<string, number> {
    const counts: Record<string, number> = {};
    const canSeeQueue =
      ability.can(Action.Manage, 'Settings') ||
      ability.can(Action.Track, Media);
    if (canSeeQueue && this.pluginCounts.has('queueActive')) {
      counts.queueActive = this.pluginCounts.get('queueActive');
    }
    return counts;
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
