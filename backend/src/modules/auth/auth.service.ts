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
import { randomBytes } from 'crypto';
import { User } from '../users/entities/user.entity';
import { LoginDto, RegisterDto } from './dto/login.dto';
import { JwtPayload } from './strategies/jwt.strategy';
import { MediaServerType, UserRole } from '../../common/enums';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
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

  async login(dto: LoginDto): Promise<{ accessToken: string; user: User }> {
    const serverType = dto.serverType ?? MediaServerType.LOCAL;

    if (serverType === MediaServerType.LOCAL) {
      return this.localLogin(dto.username, dto.password);
    }

    throw new UnauthorizedException(
      `Media server login for ${serverType} not yet implemented`,
    );
  }

  async register(dto: RegisterDto): Promise<User> {
    const existing = await this.userRepo.findOne({
      where: { username: dto.username },
    });
    if (existing) {
      throw new ConflictException('Username already taken');
    }

    const isFirstUser = (await this.userRepo.count()) === 0;

    const user = this.userRepo.create({
      username: dto.username,
      email: dto.email,
      passwordHash: await bcrypt.hash(dto.password, 12),
      role: isFirstUser ? UserRole.ADMIN : UserRole.USER,
      apiKey: this.generateApiKey(),
      mediaServerType: MediaServerType.LOCAL,
    });

    const saved = await this.userRepo.save(user);
    const { passwordHash: _, ...safeUser } = saved as any;
    return safeUser;
  }

  async validateApiKey(apiKey: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { apiKey, enabled: true } });
  }

  private async localLogin(
    username: string,
    password: string,
  ): Promise<{ accessToken: string; user: User }> {
    const user = await this.userRepo.findOne({ where: { username } });
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

    const { passwordHash, ...safeUser } = user as any;
    return { accessToken, user: safeUser };
  }

  private generateApiKey(): string {
    return randomBytes(32).toString('hex');
  }
}
