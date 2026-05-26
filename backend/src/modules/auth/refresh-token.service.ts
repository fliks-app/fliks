import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';

/** How long a refresh token is valid. Defaults to 60 days; long enough
 *  that mobile/TV users almost never re-login, short enough that a
 *  stolen token can't be replayed forever. Configurable via env. */
const DEFAULT_TTL_DAYS = 60;

export interface IssuedRefresh {
  /** Plaintext token, returned to the client once and never stored. */
  token: string;
  /** UNIX seconds when the token stops working. */
  expiresAt: number;
}

@Injectable()
export class RefreshTokenService {
  private readonly log = new Logger(RefreshTokenService.name);

  constructor(
    @InjectRepository(RefreshToken)
    private readonly repo: Repository<RefreshToken>,
    private readonly config: ConfigService,
  ) {}

  /** TTL in milliseconds, sourced from \`REFRESH_TOKEN_TTL_DAYS\`. */
  private ttlMs(): number {
    const raw = this.config.get<string>(
      'REFRESH_TOKEN_TTL_DAYS',
      String(DEFAULT_TTL_DAYS),
    );
    const n = parseInt(raw, 10);
    const days = Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_DAYS;
    return days * 24 * 60 * 60 * 1000;
  }

  private hash(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /** Issue a new refresh token for a user. Plaintext returned to caller,
   *  hash persisted. */
  async issue(user: User, userAgent?: string): Promise<IssuedRefresh> {
    const raw = crypto.randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlMs());
    await this.repo.save(
      this.repo.create({
        userId: user.id,
        tokenHash: this.hash(raw),
        expiresAt,
        userAgent: userAgent?.slice(0, 255) ?? null,
        lastUsedAt: null,
      }),
    );
    return { token: raw, expiresAt: Math.floor(expiresAt.getTime() / 1000) };
  }

  /**
   * Validate and rotate a refresh token. Returns the user it belongs to
   * if the token is live; the caller then issues a fresh access token
   * AND a fresh refresh token via {@link issue}. The presented token is
   * marked revoked atomically so it cannot be reused.
   *
   * If the token hash maps to a row that was ALREADY revoked, we treat
   * this as reuse (theft of a previously-rotated token) and revoke
   * every refresh token of the user — every device has to re-login.
   * Standard refresh-token-rotation theft detection.
   */
  async rotate(raw: string): Promise<User> {
    const hash = this.hash(raw);
    const row = await this.repo.findOne({
      where: { tokenHash: hash },
      relations: ['user', 'user.role'],
    });
    if (!row) throw new UnauthorizedException('Invalid refresh token');

    if (row.revokedAt) {
      this.log.warn(
        `RefreshToken: replay detected for user #${row.userId} — revoking every active refresh token of this user`,
      );
      await this.revokeAllForUser(row.userId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const now = new Date();
    await this.repo.update(row.id, { revokedAt: now, lastUsedAt: now });
    return row.user;
  }

  /** Revoke a single refresh token (logout from one device). */
  async revoke(raw: string): Promise<void> {
    const hash = this.hash(raw);
    await this.repo.update(
      { tokenHash: hash, revokedAt: null as unknown as Date },
      { revokedAt: new Date() },
    );
  }

  /** Revoke every active refresh token of a user (logout from all devices,
   *  or reaction to a replay attack). */
  async revokeAllForUser(userId: number): Promise<void> {
    await this.repo.update(
      { userId, revokedAt: null as unknown as Date },
      { revokedAt: new Date() },
    );
  }

  /** Best-effort cleanup of expired or long-revoked rows. Cron job. */
  async pruneStale(): Promise<number> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const expired = await this.repo.delete({
      expiresAt: LessThan(new Date()),
    });
    const oldRevoked = await this.repo
      .createQueryBuilder()
      .delete()
      .where('"revokedAt" IS NOT NULL AND "revokedAt" < :cutoff', { cutoff })
      .execute();
    return (expired.affected ?? 0) + (oldRevoked.affected ?? 0);
  }
}
