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
import {
  EventsService,
  RemoteTargetConnection,
  SseEvent,
} from '../scheduler/events.service';
import {
  LiveSessionRegistry,
  LiveSessionSnapshot,
} from '../streaming/live-session.service';
import { StreamLifetime } from '../streaming/lifetime-constants';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import { Action } from '../auth/casl/actions.enum';
import { RemoteCommandDto, REMOTE_COMMAND_ACTIONS } from './dto/remote-command.dto';
import { RemoteGrantService } from './remote-grant.service';
import { RemoteNowPlayingDto, RemoteTargetDto } from './dto/remote-target.dto';

/** Absolute deadline before a command is stale: see `RemoteCommandAction`. */
const COMMAND_TTL_MS = 10_000;

interface ResolvedTarget {
  ownerId: number;
  connectionId: string;
  ownerUsername: string | null;
}

/** Long enough to collapse a playing session's ten-second cadence, short
 *  enough that a revocation is felt promptly. */
const GRANT_CACHE_MS = 30_000;

/** A target id is `deviceId#tabNonce`: a grant covers the device, so every tab
 *  and every reconnection of it are covered by the same permission. */
function deviceIdOf(targetId: string): string {
  return targetId.split('#')[0];
}

@Injectable()
export class RemoteService {
  private readonly logger = new Logger(RemoteService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly events: EventsService,
    private readonly liveSessions: LiveSessionRegistry,
    private readonly casl: CaslAbilityFactory,
    private readonly grants: RemoteGrantService,
  ) {
    // StreamingModule can't import RemoteModule (RemoteModule already imports
    // StreamingModule, and Nest module imports must not cycle), so instead of
    // PlaybackController calling in here, EventsService calls out through this
    // hook whenever it emits a household-scoped event.
    this.events.registerHouseholdFanOut((event, ownerId) => {
      void this.fanOutToGrantees(ownerId, event);
    });
  }

  /** State frames arrive every ten seconds per playing session, so resolving the
   *  audience from the database on each one is pure waste. A revocation takes
   *  effect within the window rather than instantly, which is fine for a
   *  fan-out audience: the command path re-checks on every command. */
  private readonly viewerCache = new Map<string, { ids: number[]; at: number }>();

  /** Extend an event past the device's owner to the accounts that device has
   *  authorized. Scoped to the one device when the frame names it, so a grant on
   *  the living-room screen does not leak what the bedroom one is playing. */
  private async fanOutToGrantees(ownerId: number, event: SseEvent): Promise<void> {
    const deviceId =
      event.type === 'remote.state' || event.type === 'remote.stopped'
        ? deviceIdOf(event.targetId)
        : null;
    const key = deviceId ? `device:${deviceId}` : `owner:${ownerId}`;
    const cached = this.viewerCache.get(key);
    let viewerIds: number[];
    if (cached && Date.now() - cached.at < GRANT_CACHE_MS) {
      viewerIds = cached.ids;
    } else {
      viewerIds = deviceId
        ? await this.grants.granteesForDevice(deviceId)
        : await this.grants.granteesForOwner(ownerId);
      this.viewerCache.set(key, { ids: viewerIds, at: Date.now() });
    }
    // An admin is authorized on every target by `canControl` and sees them all
    // in the listing, so it has to receive their frames too. Without this its
    // card opened on a device it could command but never hear from, and its
    // target list only refreshed when something else happened to refetch.
    const audience = [...viewerIds, ...(await this.adminIds())];
    const extra = [...new Set(audience)].filter((id) => id !== ownerId);
    if (extra.length > 0) this.events.emitToUsers(extra, event);
  }

  private adminCache: { ids: number[]; at: number } | null = null;

  /** Cached on the same window as the audience: an admin is rare and changing
   *  one is rarer, while these frames arrive every ten seconds per session. */
  private async adminIds(): Promise<number[]> {
    if (this.adminCache && Date.now() - this.adminCache.at < GRANT_CACHE_MS) {
      return this.adminCache.ids;
    }
    const users = await this.userRepo.find({ where: { enabled: true } });
    const ids = users.filter((u) => this.isAdmin(u)).map((u) => u.id);
    this.adminCache = { ids, at: Date.now() };
    return ids;
  }

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

    // An admin is authorized on every target by `canControl`, so the listing has
    // to show them too: gating only the list left the capability reachable only
    // by knowing a target id. Household consent does not apply here, and the
    // admin streams dashboard already exposes who is playing what.
    if (this.isAdmin(me)) {
      const others = this.events
        .listAll()
        .filter((c) => c.userId !== me.id && c.targetId !== selfTargetId);
      const ownerIds = [...new Set(others.map((c) => c.userId))];
      const owners = ownerIds.length
        ? await this.userRepo.find({ where: { id: In(ownerIds) } })
        : [];
      const nameById = new Map(owners.map((u) => [u.id, u.username]));
      for (const connection of others) {
        rows.push(
          this.toDto(connection, liveSessions, nameById.get(connection.userId) ?? null),
        );
      }
      return rows;
    }

    const granted = await this.grants.grantedDevices(me.id);
    if (granted.length === 0) return rows;

    const owners = await this.userRepo.find({
      where: { id: In([...new Set(granted.map((g) => g.ownerUserId))]), enabled: true },
    });
    const grantedDeviceIds = new Set(granted.map((g) => g.deviceId));

    for (const owner of owners) {
      for (const connection of this.events.listForUser(owner.id)) {
        if (connection.targetId === selfTargetId) continue;
        // The grant is per device, so a second device of the same owner stays
        // invisible until it is granted in its own right.
        if (!grantedDeviceIds.has(deviceIdOf(connection.targetId ?? ''))) continue;
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
      throw new BadRequestException('remote.error_self_target');
    }
    // Belt and braces: `@IsIn` on the DTO already rejects this at the pipe.
    if (!REMOTE_COMMAND_ACTIONS.includes(dto.action)) {
      this.logger.warn(
        `User ${me.id} sent unknown remote action "${dto.action}" to ${targetId}`,
      );
      throw new BadRequestException('remote.error_unknown_action');
    }

    const cmdId = randomUUID();
    // Spread the validated DTO rather than re-listing its fields: the global
    // pipe whitelists it to declared properties, and a hand-written copy
    // silently dropped every field added to the protocol later.
    const delivered = this.events.emitToConnection(connectionId, {
      ...dto,
      type: 'remote.command',
      cmdId,
      expiresAt: Date.now() + COMMAND_TTL_MS,
      byTargetId: dto.byTargetId ?? null,
    });
    // Never `emitToUser` here: a fallback broadcast would let one phone pause
    // every device the target account owns.
    if (!delivered) {
      this.logger.warn(
        `Target ${targetId} resolved to a dead connection ${connectionId}: treating as offline`,
      );
      throw new NotFoundException('remote.error_device_offline');
    }

    // What this launch plays counts for the account that started it, not the one
    // the target is signed into. The device keeps its own session: only the
    // playback is attributed.
    if (dto.action === 'load' && dto.mediaFileId) {
      this.events.claimAttribution(targetId, me.id, dto.mediaFileId);
    }
    this.logger.debug(
      `Delivered ${dto.action} to ${targetId} (cmd ${cmdId})` +
        `${dto.qualityId ? ` quality=${dto.qualityId}` : ''}` +
        `${dto.trackId ? ` track=${dto.trackId}` : ''}`,
    );
    return { cmdId };
  }

  /** The authorization predicate, applied identically at listing and at the
   *  command endpoint: checking only at listing would leave a known target id
   *  commandable by anyone who guesses it. */
  async canControl(
    me: User,
    targetUserId: number | null,
    deviceId: string | null,
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

    if (!deviceId) return { allowed: false, reason: 'no_device_id' };
    // The device itself granted this, by displaying a code someone standing in
    // front of it read. No social relationship is involved.
    if (!(await this.grants.isGranted(me.id, deviceId))) {
      return { allowed: false, reason: 'device_not_granted' };
    }
    // Re-read now, not the SSE connection's connect-time snapshot: the target
    // may have been disabled hours into an already-authorized connection.
    if (!targetUser.enabled) return { allowed: false, reason: 'target_disabled' };

    return { allowed: true, reason: 'granted' };
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
      deviceName: body.name ?? null,
      userAgent: null,
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
      throw new NotFoundException('remote.error_device_offline');
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
      throw new NotFoundException('remote.error_device_offline');
    }
    const { allowed, reason } = await this.canControl(
      me,
      found.ownerId,
      deviceIdOf(targetId),
    );
    if (!allowed) {
      this.logger.warn(
        `User ${me.id} denied control of target ${targetId} (owner ${found.ownerId}): ${reason}`,
      );
      // The API answers a translation key: user-facing copy stays out of an
      // English-only backend, and the interceptor renders it.
      throw new ForbiddenException(`remote.error_${reason}`);
    }
    return found;
  }

  /** Visibility only: an id resolves within the caller's own connections or a
   *  device it has been granted, never as a global key. Consent is
   *  `canControl`'s job. */
  private async findTargetOwner(me: User, targetId: string): Promise<ResolvedTarget | null> {
    const ownConnectionId = this.events.resolveTarget(me.id, targetId);
    if (ownConnectionId) {
      return { ownerId: me.id, connectionId: ownConnectionId, ownerUsername: null };
    }

    const deviceId = deviceIdOf(targetId);
    for (const grant of await this.grants.grantedDevices(me.id)) {
      if (grant.deviceId !== deviceId) continue;
      const connectionId = this.events.resolveTarget(grant.ownerUserId, targetId);
      if (!connectionId) continue;
      const owner = await this.userRepo.findOne({ where: { id: grant.ownerUserId } });
      return {
        ownerId: grant.ownerUserId,
        connectionId,
        ownerUsername: owner?.username ?? null,
      };
    }

    // An admin is authorized on every target, so it must also be able to resolve
    // one. Kept last: a granted device answers through the clause above.
    if (this.isAdmin(me)) {
      for (const connection of this.events.listAll()) {
        if (connection.targetId !== targetId) continue;
        const owner = await this.userRepo.findOne({ where: { id: connection.userId } });
        return {
          ownerId: connection.userId,
          connectionId: connection.connectionId,
          ownerUsername: owner?.username ?? null,
        };
      }
    }

    return null;
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
      deviceName: connection.deviceName,
      systemName: live?.systemName ?? null,
      formFactor: connection.formFactor,
      tvPlatform: connection.tvPlatform,
      ownerUsername,
      nowPlaying,
    };
  }
}
