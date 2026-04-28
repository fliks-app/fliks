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

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
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
    const user = await this.userRepo.findOne({
      where: { username },
      relations: ['userRole'],
    });
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

    const payload: JwtPayload = { sub: user.id, username: user.username };
    const accessToken = this.jwtService.sign(payload);

    return { accessToken, user: this.safeUser(user) };
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
   * Issue a JWT for an existing user — used by the pairing flow when the user
   * has been authenticated through a different channel (approval from another
   * device) instead of a password.
   */
  signTokenFor(user: User): string {
    const payload: JwtPayload = { sub: user.id, username: user.username };
    return this.jwtService.sign(payload);
  }

  /**
   * Lightweight user list for the pre-login user picker. Mirrors what
   * Plex/Jellyfin expose by default — id, username, avatar — and never any
   * sensitive field. Caller is unauthenticated.
   */
  async publicUserList(): Promise<{ id: number; username: string; avatar: string | null }[]> {
    const users = await this.userRepo.find({
      where: { enabled: true },
      select: ['id', 'username', 'avatar'],
      order: { username: 'ASC' },
    });
    return users.map((u) => ({ id: u.id, username: u.username, avatar: u.avatar ?? null }));
  }
}
