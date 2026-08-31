import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { User } from '../users/entities/user.entity';
import { UserFollow } from '../social/entities/user-follow.entity';
import { FollowStatus } from '../../common/enums';
import {
  EventsService,
  RemoteTargetConnection,
} from '../scheduler/events.service';
import {
  LiveSessionRegistry,
  LiveSessionSnapshot,
} from '../streaming/live-session.service';
import { StreamLifetime } from '../streaming/lifetime-constants';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import { Action } from '../auth/casl/actions.enum';
import { SocialService } from '../social/social.service';
import { RemoteCommandDto, REMOTE_COMMAND_ACTIONS } from './dto/remote-command.dto';
import { RemoteNowPlayingDto, RemoteTargetDto } from './dto/remote-target.dto';

/** Absolute deadline before a command is stale: see `RemoteCommandAction`. */
const COMMAND_TTL_MS = 10_000;

interface ResolvedTarget {
  ownerId: number;
  connectionId: string;
  ownerUsername: string | null;
}

@Injectable()
export class RemoteService {
  private readonly logger = new Logger(RemoteService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserFollow)
    private readonly followRepo: Repository<UserFollow>,
    private readonly events: EventsService,
    private readonly liveSessions: LiveSessionRegistry,
    private readonly casl: CaslAbilityFactory,
    private readonly social: SocialService,
  ) {}

  /** The caller's own devices, plus any household member's devices the caller
   *  is authorized to control. `selfTargetId` is a UX filter (the caller's own
   *  screen), never a security boundary: the real one is `canControl`. */
  async listTargets(me: User, selfTargetId: string | null): Promise<RemoteTargetDto[]> {
    const liveSessions = this.liveSessions.list();
    const rows: RemoteTargetDto[] = [];

    for (const connection of this.events.listForUser(me.id)) {
      if (connection.targetId === selfTargetId) continue;
      rows.push(this.toDto(connection, liveSessions, null));
    }

    if (me.shareDisabled || !me.allowRemoteControlOfOthers) return rows;

    const mutualIds = await this.mutualFollowerIds(me.id);
    if (mutualIds.length === 0) return rows;

    const owners = await this.userRepo.find({
      where: {
        id: In(mutualIds),
        enabled: true,
        shareDisabled: false,
        allowRemoteControlOfMyDevices: true,
      },
    });
    for (const owner of owners) {
      for (const connection of this.events.listForUser(owner.id)) {
        if (connection.targetId === selfTargetId) continue;
        rows.push(this.toDto(connection, liveSessions, owner.username));
      }
    }

    return rows;
  }

  async sendCommand(
    me: User,
    targetId: string,
    dto: RemoteCommandDto,
  ): Promise<{ cmdId: string }> {
    const { connectionId } = await this.authorizeTarget(me, targetId);

    if (targetId === dto.byTargetId) {
      this.logger.warn(
        `User ${me.id} sent a command from target ${targetId} to itself`,
      );
      throw new BadRequestException('self_target');
    }
    // Belt and braces: `@IsIn` on the DTO already rejects this at the pipe.
    if (!REMOTE_COMMAND_ACTIONS.includes(dto.action)) {
      this.logger.warn(
        `User ${me.id} sent unknown remote action "${dto.action}" to ${targetId}`,
      );
      throw new BadRequestException('unknown_action');
    }

    const cmdId = randomUUID();
    const delivered = this.events.emitToConnection(connectionId, {
      type: 'remote.command',
      cmdId,
      expiresAt: Date.now() + COMMAND_TTL_MS,
      byTargetId: dto.byTargetId ?? null,
      action: dto.action,
      mediaId: dto.mediaId,
      mediaFileId: dto.mediaFileId,
      episodeId: dto.episodeId,
      positionSeconds: dto.positionSeconds,
      level: dto.level,
      muted: dto.muted,
      trackId: dto.trackId,
      subtitleId: dto.subtitleId,
    });
    // Never `emitToUser` here: a fallback broadcast would let one phone pause
    // every device the target account owns.
    if (!delivered) {
      this.logger.warn(
        `Target ${targetId} resolved to a dead connection ${connectionId}: treating as offline`,
      );
      throw new NotFoundException('device_offline');
    }

    return { cmdId };
  }

  /** The authorization predicate, applied identically at listing and at the
   *  command endpoint: checking only at listing would leave a known target id
   *  commandable by anyone who guesses it. */
  async canControl(
    me: User,
    targetUserId: number | null,
  ): Promise<{ allowed: boolean; reason: string }> {
    if (targetUserId == null) {
      // The admin-only "shared device" case: a target with no owning profile.
      return this.isAdmin(me)
        ? { allowed: true, reason: 'admin' }
        : { allowed: false, reason: 'ownerless_target_requires_admin' };
    }
    if (targetUserId === me.id) return { allowed: true, reason: 'self' };
    if (this.isAdmin(me)) return { allowed: true, reason: 'admin' };

    const targetUser = await this.userRepo.findOne({ where: { id: targetUserId } });
    if (!targetUser) return { allowed: false, reason: 'target_user_missing' };

    if (!targetUser.allowRemoteControlOfMyDevices) {
      return { allowed: false, reason: 'target_opted_out' };
    }
    if (!me.allowRemoteControlOfOthers) {
      return { allowed: false, reason: 'caller_lacks_control_grant' };
    }
    // Both directions ACCEPTED: a public-profile follow is auto-accepted with no
    // consent from the target, so a one-way follow must never grant control.
    if (!(await this.social.areMutualFollowers(me.id, targetUserId))) {
      return { allowed: false, reason: 'not_mutual_followers' };
    }
    if (me.shareDisabled) return { allowed: false, reason: 'caller_share_disabled' };
    if (targetUser.shareDisabled) return { allowed: false, reason: 'target_share_disabled' };
    // Re-read now, not the SSE connection's connect-time snapshot: the target
    // may have been disabled hours into an already-authorized connection.
    if (!targetUser.enabled) return { allowed: false, reason: 'target_disabled' };

    return { allowed: true, reason: 'household' };
  }

  private isAdmin(user: User): boolean {
    return this.casl.createForUser(user).can(Action.Manage, 'Settings');
  }

  /** Announce a client that cannot hold an SSE stream (the native TV app has no
   *  streaming primitive, so it polls). The id is derived server-side: a
   *  client-supplied one would let a caller squat another device's slot. */
  registerPolledTarget(
    me: User,
    body: { deviceId: string; name?: string; formFactor?: string },
  ): { targetId: string } {
    const targetId = `${body.deviceId}#native`;
    this.events.registerPolledTarget(me.id, {
      targetId,
      formFactor: body.formFactor ?? 'tv',
      tvPlatform: null,
      userAgent: body.name ?? null,
    });
    return { targetId };
  }

  /** Drain what a polling target has waiting. An unknown target must not read
   *  as "nothing waiting", or a mis-registered device polls forever in silence. */
  async drainCommands(me: User, targetId: string): Promise<unknown[]> {
    await this.authorizeTarget(me, targetId);
    const pending = this.events.drainCommands(me.id, targetId);
    if (pending === null) {
      this.logger.warn(`User ${me.id} polled unknown target ${targetId}`);
      throw new NotFoundException('device_offline');
    }
    return pending;
  }

  /** Resolve `targetId` to a connection, then apply `canControl`. 404 when the
   *  target is unknown or outside the caller's visible scope (own + household);
   *  403 when it's visible but the consent predicate denies it: logged either
   *  way so a silent deny never happens on this path. */
  private async authorizeTarget(me: User, targetId: string): Promise<ResolvedTarget> {
    const found = await this.findTargetOwner(me, targetId);
    if (!found) {
      this.logger.warn(`User ${me.id} reached for unknown/invisible target ${targetId}`);
      throw new NotFoundException('device_offline');
    }
    const { allowed, reason } = await this.canControl(me, found.ownerId);
    if (!allowed) {
      this.logger.warn(
        `User ${me.id} denied control of target ${targetId} (owner ${found.ownerId}): ${reason}`,
      );
      throw new ForbiddenException(reason);
    }
    return found;
  }

  /** Visibility only: an id resolves within the caller's own connections or a
   *  mutual follower's, never as a global key. Consent is `canControl`'s job. */
  private async findTargetOwner(me: User, targetId: string): Promise<ResolvedTarget | null> {
    const ownConnectionId = this.events.resolveTarget(me.id, targetId);
    if (ownConnectionId) {
      return { ownerId: me.id, connectionId: ownConnectionId, ownerUsername: null };
    }

    for (const ownerId of await this.mutualFollowerIds(me.id)) {
      const connectionId = this.events.resolveTarget(ownerId, targetId);
      if (!connectionId) continue;
      const owner = await this.userRepo.findOne({ where: { id: ownerId } });
      return { ownerId, connectionId, ownerUsername: owner?.username ?? null };
    }

    return null;
  }

  /** Mutual (both ACCEPTED) follow edges: the structural "household" scope
   *  that bounds target discovery, independent of either side's opt-in flags. */
  private async mutualFollowerIds(userId: number): Promise<number[]> {
    const [following, followers] = await Promise.all([
      this.followRepo.find({
        where: { follower: { id: userId }, status: FollowStatus.ACCEPTED },
      }),
      this.followRepo.find({
        where: { following: { id: userId }, status: FollowStatus.ACCEPTED },
      }),
    ]);
    const followingIds = new Set(following.map((f) => f.followingId));
    return followers.map((f) => f.followerId).filter((id) => followingIds.has(id));
  }

  private toDto(
    connection: RemoteTargetConnection,
    liveSessions: LiveSessionSnapshot[],
    ownerUsername: string | null,
  ): RemoteTargetDto {
    const live = liveSessions.find((s) => s.sseConnectionId === connection.connectionId);
    let nowPlaying: RemoteNowPlayingDto | null = null;
    if (live) {
      const staleMs = Date.now() - live.lastBeat.getTime();
      if (staleMs > StreamLifetime.liveSessionTtlMs()) {
        this.logger.debug(
          `Live session ${live.sessionId} for target ${connection.targetId} is stale: omitting nowPlaying`,
        );
      } else {
        nowPlaying = {
          mediaFileId: live.mediaFileId,
          mediaTitle: live.mediaTitle,
          mediaType: live.mediaType,
          posterUrl: live.posterUrl,
          positionSeconds: live.position,
          state: live.state,
        };
      }
    }

    return {
      // `listForUser` already filters out entries with no target id.
      targetId: connection.targetId as string,
      userAgent: connection.userAgent,
      systemName: live?.systemName ?? null,
      formFactor: connection.formFactor,
      tvPlatform: connection.tvPlatform,
      ownerUsername,
      nowPlaying,
    };
  }
}
