import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../users/entities/user.entity';
import { Role } from '../roles/entities/role.entity';
import { LoginDto, RegisterDto } from './dto/login.dto';
import { JwtPayload } from './strategies/jwt.strategy';
import { MediaServerType } from '../../common/enums';
import { DEFAULT_ROLES } from '../../common/constants/permissions';
import type { PublicUser } from '../users/users.service';
import { RefreshTokenService } from './refresh-token.service';

export interface TokenPair {
  accessToken: string;
  /** Plaintext refresh token. Returned once, never again — store
   *  client-side (Capacitor Preferences on native, localStorage web). */
  refreshToken: string;
  /** UNIX seconds when the access token expires. Lets the client
   *  schedule a proactive refresh just before it does. */
  accessTokenExpiresAt: number;
  /** UNIX seconds when the refresh token expires. After this the user
   *  has to log in again. */
  refreshTokenExpiresAt: number;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  /** Durée du cookie httpOnly (alignée sur JWT_EXPIRATION). */
  getAccessCookieMaxAgeMs(): number {
    const raw = this.config.get<string>('JWT_EXPIRATION', '7d');
    const m = /^(\d+)([dhms])$/i.exec(raw.trim());
    if (!m) return 7 * 24 * 60 * 60 * 1000;
    const n = parseInt(m[1], 10);
    const u = m[2].toLowerCase();
    const mult =
      u === 'd' ? 86400000 : u === 'h' ? 3600000 : u === 'm' ? 60000 : 1000;
    return n * mult;
  }

  async login(
    dto: LoginDto,
  ): Promise<{ accessToken: string; user: PublicUser }> {
    const serverType = dto.serverType ?? MediaServerType.LOCAL;

    if (serverType === MediaServerType.LOCAL) {
      return this.localLogin(dto.username, dto.password);
    }

    throw new UnauthorizedException(
      `Media server login for ${serverType} not yet implemented`,
    );
  }

  async register(dto: RegisterDto): Promise<PublicUser> {
    const existing = await this.userRepo.findOne({
      where: { username: dto.username },
    });
    if (existing) {
      throw new ConflictException('Username already taken');
    }

    const isFirstUser = (await this.userRepo.count()) === 0;

    // Find the appropriate role
    const roleName = isFirstUser ? 'Admin' : null;
    let role: Role | null = null;
    if (roleName) {
      role = await this.roleRepo.findOne({ where: { name: roleName } });
    }
    if (!role) {
      role = await this.roleRepo.findOne({ where: { isDefault: true } });
    }
    // Last resort: seed roles if none exist yet (first startup)
    if (!role) {
      for (const [name, permissions] of Object.entries(DEFAULT_ROLES)) {
        await this.roleRepo.save(
          this.roleRepo.create({
            name,
            permissions,
            isDefault: name === 'User',
          }),
        );
      }
      role = await this.roleRepo.findOne({
        where: { name: isFirstUser ? 'Admin' : 'User' },
      });
    }

    const user = this.userRepo.create({
      username: dto.username,
      email: dto.email,
      passwordHash: await bcrypt.hash(dto.password, 12),
      roleId: role?.id,
      isAdmin: isFirstUser,
      mediaServerType: MediaServerType.LOCAL,
    });

    const saved = await this.userRepo.save(user);
    return this.safeUser(saved);
  }

  /** Strip sensitive fields and add computed permissions. */
  safeUser(user: User): PublicUser {
    const { passwordHash, userRole, ...rest } = user;
    void passwordHash;
    return {
      ...rest,
      permissions: user.permissions,
      // Fallback to "Admin" when the user has no custom role but the isAdmin
      // flag is set — otherwise the dropdown / users list would show an empty
      // role line for the original superuser.
      role: userRole?.name ?? (user.isAdmin ? 'Admin' : null),
      // Not hydrated here — callers that need libraryIds should use
      // UsersService.findOne(). Auth payloads don't carry ACL.
      libraryIds: [],
    };
  }

  private async localLogin(
    username: string,
    password: string,
  ): Promise<{ accessToken: string; user: PublicUser }> {
    // passwordHash is select:false on the entity — the bcrypt compare below
    // is the one read path that must opt back in.
    const user = await this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .leftJoinAndSelect('user.userRole', 'userRole')
      .where('user.username = :username', { username })
      .getOne();
    if (!user?.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.enabled) {
      throw new UnauthorizedException('Account disabled');
    }

    user.lastLogin = new Date();
    await this.userRepo.save(user);

    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.safeUser(user) };
  }

  /**
   * Build a short-lived access token paired with a long-lived refresh
   * token. The refresh token's plaintext is returned only here — the
   * DB stores its hash so a leaked dump can't be replayed. Used by
   * login, pairing approval, and the rotation endpoint.
   */
  async issueTokenPair(user: User, userAgent?: string): Promise<TokenPair> {
    const payload: JwtPayload = { sub: user.id, username: user.username };
    const accessToken = this.jwtService.sign(payload);
    const accessExp = this.jwtService.decode(accessToken)?.exp;
    const accessTokenExpiresAt =
      typeof accessExp === 'number'
        ? accessExp
        : Math.floor(Date.now() / 1000) + 3600;
    const refresh = await this.refreshTokenService.issue(user, userAgent);
    return {
      accessToken,
      refreshToken: refresh.token,
      accessTokenExpiresAt,
      refreshTokenExpiresAt: refresh.expiresAt,
    };
  }

  /**
   * Exchange a refresh token for a fresh access + refresh pair.
   * Rotation: the presented refresh token is revoked immediately,
   * regardless of outcome.
   */
  async refresh(rawRefreshToken: string, userAgent?: string): Promise<TokenPair> {
    const user = await this.refreshTokenService.rotate(rawRefreshToken);
    if (!user.enabled) {
      throw new UnauthorizedException('Account disabled');
    }
    return this.issueTokenPair(user, userAgent);
  }

  /** Revoke a single refresh token (logout on one device). */
  async revokeRefreshToken(rawRefreshToken: string): Promise<void> {
    await this.refreshTokenService.revoke(rawRefreshToken);
  }

  /**
   * Bump `User.lastLogin` to record activity. Called from GET /auth/me so the
   * value tracks "last active" rather than literal login. Throttled to one
   * write per minute per user to avoid hammering the DB on rapid polls.
   */
  async touchActivity(user: User): Promise<void> {
    const now = Date.now();
    const last = user.lastLogin ? user.lastLogin.getTime() : 0;
    if (now - last < 60_000) return; // throttle: skip if updated within the last minute
    await this.userRepo.update(user.id, { lastLogin: new Date(now) });
  }

  /** Generate a JWT for Chromecast (4h — long enough for extended cuts) */
  generateCastToken(user: User): string {
    const payload: JwtPayload = { sub: user.id, username: user.username };
    return this.jwtService.sign(payload, { expiresIn: '4h' });
  }

  /**
   * Long-lived JWT (12h) used by the player + offline-download flow to
   * authenticate manifest, segment, direct-play and subtitle fetches.
   *
   * The regular access JWT lives 1h with refresh-rotation — fine for API
   * calls (every Angular request goes through the interceptor and can be
   * rotated mid-flight). It is not fine for ExoPlayer / AVPlay / Shaka:
   * those engines bake the auth header at \`engine.load()\` and never
   * re-ask Angular for a fresh one, so a 2h film with a 1h token would
   * break halfway. This token gives the engines a window large enough
   * to cover essentially any single playback session.
   *
   * Security envelope (deliberately accepted — see issue #356). The token is
   * long-lived, stateless and carries no per-file or per-session claim, so a
   * leaked manifest URL is replayable until expiry. The blast radius is bounded
   * on four sides and the residual risk is judged acceptable rather than
   * traded against the playback breakage a shorter TTL or session-binding would
   * introduce (engines can't re-bake mid-stream):
   *   1. user-scoped via `sub` — replays only the holder's OWN content;
   *   2. every stream route still runs `resolveFile(mediaFileId, user)` under
   *      `JwtOrApiKeyGuard`, enforcing the live library ACL on each request;
   *   3. the manifest / segment routes are sid-gated (`assertFreshSession`
   *      410s a stopped/GC'd session), so URLs die with their LiveSession;
   *   4. disabling/deleting the user invalidates the token on its next use
   *      (the strategy re-checks `enabled`).
   * Tightening further (jti=sid binding, shorter TTL) is tracked but not done:
   * it reworks the client's token-reuse flow and risks mid-playback reloads for
   * a marginal gain over the above.
   */
  generateStreamToken(user: User): string {
    const ttl = this.config.get<string>('STREAM_TOKEN_TTL', '12h');
    const payload: JwtPayload = { sub: user.id, username: user.username };
    // \`expiresIn\` is typed as the \`ms\` library's \`StringValue\`, a
    // template literal type that won't accept a bare \`string\` from
    // env. The runtime accepts anything \`ms()\` parses ("12h", "7d",
    // numeric seconds, …) so we widen via cast.
    return this.jwtService.sign(payload, {
      expiresIn: ttl as unknown as number,
    });
  }

  /** Stream-token TTL in ms — frontend uses this to decide when to refresh. */
  getStreamTokenTtlMs(): number {
    const raw = this.config.get<string>('STREAM_TOKEN_TTL', '12h');
    const m = /^(\d+)([dhms])$/i.exec(raw.trim());
    if (!m) return 12 * 60 * 60 * 1000;
    const n = parseInt(m[1], 10);
    const u = m[2].toLowerCase();
    const mult =
      u === 'd' ? 86400000 : u === 'h' ? 3600000 : u === 'm' ? 60000 : 1000;
    return n * mult;
  }

  /**
   * Issue a JWT for an existing user — used by the pairing flow when the user
   * has been authenticated through a different channel (approval from another
   * device) instead of a password.
   */
  signTokenFor(user: User): string {
    const payload: JwtPayload = { sub: user.id, username: user.username };
    return this.jwtService.sign(payload);
  }

  /**
   * Lightweight user list for the pre-login user picker. Returns only
   * id, username, avatar — never any sensitive field. Caller is
   * unauthenticated.
   */
  async publicUserList(): Promise<
    { id: number; username: string; avatar: string | null }[]
  > {
    const users = await this.userRepo.find({
      where: { enabled: true },
      select: ['id', 'username', 'avatar'],
      order: { username: 'ASC' },
    });
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      avatar: u.avatar ?? null,
    }));
  }
}
