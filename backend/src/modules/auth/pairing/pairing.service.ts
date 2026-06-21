import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LessThan, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { AuthService } from '../auth.service';
import { User } from '../../users/entities/user.entity';
import { EventsService } from '../../scheduler/events.service';
import {
  PairingRequest,
  PairingStatus,
} from './entities/pairing-request.entity';

const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PENDING_PER_DEVICE = 3;

export interface PendingRequestDto {
  pairingId: string;
  deviceId: string;
  deviceName: string;
  systemName: string | null;
  requestedAt: Date;
  expiresAt: Date;
}

/**
 * Quick-connect pairing flow — the TV asks the server to log in as a chosen
 * user; the user, on a phone they're already logged into, sees the request on
 * a dedicated page and approves or denies.
 *
 * Code-less by design: identification relies on the device picking a user from
 * the public list, plus the deviceName showing on the phone for trust.
 */
@Injectable()
export class PairingService {
  private readonly logger = new Logger(PairingService.name);

  constructor(
    @InjectRepository(PairingRequest)
    private readonly repo: Repository<PairingRequest>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly authService: AuthService,
    private readonly events: EventsService,
  ) {}

  /** Issued by the unauthenticated requester (TV). Returns the publicId to poll. */
  async request(
    userId: number,
    deviceId: string,
    deviceName: string,
    systemName?: string,
  ): Promise<{ pairingId: string; expiresIn: number }> {
    const user = await this.userRepo.findOne({
      where: { id: userId, enabled: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const pending = await this.repo.count({
      where: { deviceId, status: 'pending' },
    });
    if (pending >= MAX_PENDING_PER_DEVICE) {
      throw new BadRequestException(
        'Too many pending requests for this device',
      );
    }

    const now = Date.now();
    const entity = this.repo.create({
      publicId: randomUUID(),
      userId,
      deviceId,
      deviceName: deviceName.slice(0, 80),
      systemName: systemName?.slice(0, 60) ?? null,
      status: 'pending' as PairingStatus,
      accessToken: null,
      expiresAt: new Date(now + PAIRING_TTL_MS),
    });
    const saved = await this.repo.save(entity);

    // Live update for any phone currently on /pending-requests for this user.
    // Filtering is enforced client-side: the SSE stream is per-client, the
    // event carries userId and consumers ignore foreign rows.
    this.events.emit({
      type: 'pairing.requested',
      userId,
      pairingId: saved.publicId,
      deviceName: saved.deviceName,
      deviceId: saved.deviceId,
    });

    return {
      pairingId: saved.publicId,
      expiresIn: Math.floor(PAIRING_TTL_MS / 1000),
    };
  }

  /**
   * Read-and-flush the status. Token is returned at most once and only when
   * the same `deviceId` that issued the request asks: leaks the publicId
   * without leaking the token.
   */
  async status(
    publicId: string,
    deviceId: string,
  ): Promise<{
    status: PairingStatus;
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: number;
    refreshTokenExpiresAt?: number;
  }> {
    const req = await this.repo.findOne({ where: { publicId } });
    if (!req) throw new NotFoundException('Pairing request not found');

    if (req.status === 'pending' && req.expiresAt.getTime() < Date.now()) {
      req.status = 'expired';
      await this.repo.save(req);
    }

    // Single-use claim: \`accessToken='__approved__'\` is the sentinel
    // set at \`approve\` time, cleared once the matching device polls
    // and we issue real tokens. Keeps the issuance fresh (the access
    // token is short-lived now — pre-issuing at approve would burn
    // most of its lifetime before the device polled) and adds a real
    // refresh token to the response so the TV doesn't get logged out
    // an hour later.
    if (
      req.status === 'approved' &&
      req.deviceId === deviceId &&
      req.accessToken === '__approved__' &&
      req.approvedByUserId
    ) {
      const user = await this.userRepo.findOne({
        where: { id: req.approvedByUserId },
      });
      if (!user) {
        return { status: req.status };
      }
      const tokens = await this.authService.issueTokenPair(user);
      req.accessToken = null; // claimed
      await this.repo.save(req);
      return { status: req.status, ...tokens };
    }

    return { status: req.status };
  }

  /** Phone-side: list pending requests for the calling user. */
  async listPendingForUser(userId: number): Promise<PendingRequestDto[]> {
    const rows = await this.repo.find({
      where: { userId, status: 'pending' },
      order: { createdAt: 'DESC' },
    });
    const now = Date.now();
    return rows
      .filter((r) => r.expiresAt.getTime() >= now)
      .map((r) => ({
        pairingId: r.publicId,
        deviceId: r.deviceId,
        deviceName: r.deviceName,
        systemName: r.systemName,
        requestedAt: r.createdAt,
        expiresAt: r.expiresAt,
      }));
  }

  async approve(publicId: string, user: User): Promise<void> {
    const req = await this.fetchOwnedByUser(publicId, user.id);
    if (req.status !== 'pending') {
      throw new BadRequestException(`Cannot approve a ${req.status} request`);
    }
    if (req.expiresAt.getTime() < Date.now()) {
      req.status = 'expired';
      await this.repo.save(req);
      throw new BadRequestException('Pairing request expired');
    }
    req.status = 'approved';
    req.approvedByUserId = user.id;
    // Sentinel: real tokens are minted when the matching device polls
    // \`/status\`. Pre-issuing here would waste most of an access token's
    // 1h lifetime before the device picks it up.
    req.accessToken = '__approved__';
    await this.repo.save(req);
  }

  async deny(publicId: string, user: User): Promise<void> {
    const req = await this.fetchOwnedByUser(publicId, user.id);
    if (req.status !== 'pending') return; // idempotent
    req.status = 'denied';
    req.approvedByUserId = user.id;
    await this.repo.save(req);
  }

  /**
   * Sweep expired rows hourly. Lazy expiration also flips status on reads, so
   * this is purely housekeeping to keep the table small.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpired(): Promise<void> {
    const cutoff = new Date(Date.now() - PAIRING_TTL_MS);
    const result = await this.repo.delete({ expiresAt: LessThan(cutoff) });
    if (result.affected) {
      this.logger.log(`Cleaned up ${result.affected} expired pairing requests`);
    }
  }

  private async fetchOwnedByUser(
    publicId: string,
    userId: number,
  ): Promise<PairingRequest> {
    const req = await this.repo.findOne({ where: { publicId } });
    if (!req) throw new NotFoundException('Pairing request not found');
    if (req.userId !== userId) {
      // Pretend it doesn't exist — never leak that a different user's request lives at this id.
      throw new NotFoundException('Pairing request not found');
    }
    return req;
  }
}
