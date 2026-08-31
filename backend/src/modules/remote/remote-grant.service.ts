import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import { randomInt } from 'crypto';
import { RemoteControlGrant } from './entities/remote-control-grant.entity';
import { User } from '../users/entities/user.entity';
import { EventsService } from '../scheduler/events.service';

/** Long enough to walk to another room, short enough that a code left on screen
 *  stops being useful. */
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_UNCLAIMED_PER_DEVICE = 3;
/** No I, O, 0 or 1: the code is read off a screen, often across a room. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export interface GrantDto {
  id: number;
  deviceId: string;
  deviceName: string;
  /** Set on a row the caller may control; the account offering the device. */
  ownerUsername: string | null;
  /** Set on a row the caller's own device issued; the account it authorized. */
  granteeUsername: string | null;
  createdAt: string;
}

/**
 * Standing per-device control permissions.
 *
 * Replaces mutual-follow gating: proximity to the screen is the consent, so no
 * social relationship is needed and the permission is scoped to one device
 * instead of to everything an account owns.
 */
@Injectable()
export class RemoteGrantService {
  private readonly logger = new Logger(RemoteGrantService.name);

  constructor(
    @InjectRepository(RemoteControlGrant)
    private readonly repo: Repository<RemoteControlGrant>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly events: EventsService,
  ) {}

  /** A grant appearing or ending changes what a controller may see, and nothing
   *  else would tell it: without this a revoked device sat in the picker until
   *  the next command failed. */
  private announce(...userIds: (number | null)[]): void {
    for (const id of new Set(userIds.filter((i): i is number => i !== null))) {
      this.events.emitToUser(id, { type: 'remote.targets_changed' });
    }
  }

  /** Offer this device for control: returns the code to display on it. */
  async createCode(
    owner: User,
    deviceId: string,
    deviceName: string,
  ): Promise<{ id: number; code: string; expiresIn: number }> {
    await this.pruneExpiredCodes();

    const unclaimed = await this.repo.count({
      where: { deviceId, granteeUserId: IsNull() },
    });
    if (unclaimed >= MAX_UNCLAIMED_PER_DEVICE) {
      this.logger.warn(`Device ${deviceId} has too many unclaimed codes`);
      throw new BadRequestException('remote.error_too_many_codes');
    }

    const code = await this.mintCode();
    const saved = await this.repo.save(
      this.repo.create({
        code,
        deviceId,
        ownerUserId: owner.id,
        granteeUserId: null,
        deviceName: deviceName.slice(0, 80),
        codeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
      }),
    );
    this.logger.log(
      `Device ${deviceId} offered control by user ${owner.id} (grant ${saved.id})`,
    );
    // The id comes back so the device can withdraw a code it no longer wants
    // on screen, through the same revoke path a claimed grant uses.
    return { id: saved.id, code, expiresIn: Math.floor(CODE_TTL_MS / 1000) };
  }

  /** Claim a displayed code. Being able to read it is the whole proof. */
  async claim(grantee: User, rawCode: string): Promise<GrantDto> {
    const code = rawCode.trim().toUpperCase();
    const row = await this.repo.findOne({
      where: { code, granteeUserId: IsNull() },
    });
    if (!row) {
      this.logger.warn(`User ${grantee.id} presented an unknown control code`);
      throw new NotFoundException('remote.error_unknown_code');
    }
    if (row.codeExpiresAt.getTime() < Date.now()) {
      await this.repo.delete(row.id);
      this.logger.warn(`User ${grantee.id} presented an expired control code`);
      throw new NotFoundException('remote.error_expired_code');
    }
    if (row.ownerUserId === grantee.id) {
      // Its own devices are already listed: consuming the code here would
      // spend it for nothing and leave the user wondering why.
      this.logger.warn(`User ${grantee.id} claimed a code from its own device`);
      throw new BadRequestException('remote.error_own_device');
    }

    const existing = await this.repo.findOne({
      where: { deviceId: row.deviceId, granteeUserId: grantee.id },
    });
    if (existing) {
      await this.repo.delete(row.id);
      return this.toDto(existing, await this.usernames([existing]));
    }

    // The code is cleared, not kept: a grant must not stay reachable by a
    // string that was displayed on a screen.
    row.code = null;
    row.granteeUserId = grantee.id;
    const saved = await this.repo.save(row);
    this.logger.log(
      `Device ${saved.deviceId} now controllable by user ${grantee.id} (grant ${saved.id})`,
    );
    this.announce(grantee.id, saved.ownerUserId);
    return this.toDto(saved, await this.usernames([saved]));
  }

  /** Devices this account may control. */
  async listForGrantee(userId: number): Promise<GrantDto[]> {
    const rows = await this.repo.find({ where: { granteeUserId: userId } });
    const names = await this.usernames(rows);
    return rows.map((r) => this.toDto(r, names));
  }

  /** Accounts this account's devices have authorized. Scoped to one device when
   *  asked from that device's own settings screen, which is where revoking what
   *  *this* screen handed out belongs. */
  async listForOwner(userId: number, deviceId?: string): Promise<GrantDto[]> {
    const rows = await this.repo.find({
      where: {
        ownerUserId: userId,
        granteeUserId: Not(IsNull()),
        ...(deviceId ? { deviceId } : {}),
      },
    });
    const names = await this.usernames(rows);
    return rows.map((r) => this.toDto(r, names));
  }

  /** Either side can end it: the device owner, or whoever holds the grant. */
  async revoke(id: number, me: User): Promise<void> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('remote.error_unknown_grant');
    if (row.ownerUserId !== me.id && row.granteeUserId !== me.id) {
      this.logger.warn(`User ${me.id} tried to revoke unrelated grant ${id}`);
      throw new NotFoundException('remote.error_unknown_grant');
    }
    await this.repo.delete(id);
    this.logger.log(`Grant ${id} on device ${row.deviceId} revoked by ${me.id}`);
    this.announce(row.granteeUserId, row.ownerUserId);
  }

  /** Whether `granteeUserId` may control this device. */
  async isGranted(granteeUserId: number, deviceId: string): Promise<boolean> {
    const count = await this.repo.count({
      where: { deviceId, granteeUserId },
    });
    return count > 0;
  }

  /** Device ids this account may control, for building the target list. */
  async grantedDevices(
    granteeUserId: number,
  ): Promise<{ deviceId: string; ownerUserId: number }[]> {
    const rows = await this.repo.find({ where: { granteeUserId } });
    return rows.map((r) => ({ deviceId: r.deviceId, ownerUserId: r.ownerUserId }));
  }

  /** Accounts allowed to see this device's state frames. */
  async granteesForDevice(deviceId: string): Promise<number[]> {
    const rows = await this.repo.find({ where: { deviceId } });
    return rows
      .map((r) => r.granteeUserId)
      .filter((id): id is number => id !== null);
  }

  /** Accounts allowed to see any of this owner's devices. */
  async granteesForOwner(ownerUserId: number): Promise<number[]> {
    const rows = await this.repo.find({ where: { ownerUserId } });
    return rows
      .map((r) => r.granteeUserId)
      .filter((id): id is number => id !== null);
  }

  private async pruneExpiredCodes(): Promise<void> {
    await this.repo.delete({
      granteeUserId: IsNull(),
      codeExpiresAt: LessThan(new Date()),
    });
  }

  /** Retries rather than trusting one draw: the alphabet is small enough that a
   *  collision with a live code is possible, and a duplicate would hand one
   *  device's permission to whoever typed it first. */
  private async mintCode(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = Array.from(
        { length: CODE_LENGTH },
        () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
      ).join('');
      const clash = await this.repo.count({ where: { code } });
      if (!clash) return code;
    }
    this.logger.error('Could not mint a free control code in 10 attempts');
    throw new BadRequestException('remote.error_code_unavailable');
  }

  private async usernames(
    rows: RemoteControlGrant[],
  ): Promise<Map<number, string>> {
    const ids = new Set<number>();
    for (const r of rows) {
      ids.add(r.ownerUserId);
      if (r.granteeUserId !== null) ids.add(r.granteeUserId);
    }
    if (!ids.size) return new Map();
    const users = await this.userRepo.findByIds([...ids]);
    return new Map(users.map((u) => [u.id, u.username]));
  }

  private toDto(
    row: RemoteControlGrant,
    names: Map<number, string>,
  ): GrantDto {
    return {
      id: row.id,
      deviceId: row.deviceId,
      deviceName: row.deviceName,
      ownerUsername: names.get(row.ownerUserId) ?? null,
      granteeUsername:
        row.granteeUserId !== null ? (names.get(row.granteeUserId) ?? null) : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
