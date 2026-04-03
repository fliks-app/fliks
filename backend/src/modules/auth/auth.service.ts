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

  async login(dto: LoginDto): Promise<{ accessToken: string; user: any }> {
    const serverType = dto.serverType ?? MediaServerType.LOCAL;

    if (serverType === MediaServerType.LOCAL) {
      return this.localLogin(dto.username, dto.password);
    }

    throw new UnauthorizedException(
      `Media server login for ${serverType} not yet implemented`,
    );
  }

  async register(dto: RegisterDto): Promise<any> {
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
  safeUser(user: User): any {
    const { passwordHash, userRole, ...rest } = user as any;
    return {
      ...rest,
      permissions: user.permissions,
      role: user.userRole?.name ?? null,
      isAdmin: user.isAdmin,
    };
  }

  private async localLogin(
    username: string,
    password: string,
  ): Promise<{ accessToken: string; user: any }> {
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

}
