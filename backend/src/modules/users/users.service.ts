import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { User } from './entities/user.entity';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserRole } from '../../common/enums';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  findAll(): Promise<User[]> {
    return this.userRepo.find({ order: { username: 'ASC' } });
  }

  async findOne(id: number): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User #${id} not found`);
    return user;
  }

  /**
   * Admin can update any user.
   * Regular users can only update themselves (no role/enabled changes).
   */
  async update(targetId: number, dto: UpdateUserDto, requester: User): Promise<User> {
    const target = await this.findOne(targetId);
    const isSelf = requester.id === targetId;
    const isAdmin = requester.role === UserRole.ADMIN;

    if (!isSelf && !isAdmin) throw new ForbiddenException();

    if (dto.username !== undefined) {
      const dup = await this.userRepo.findOne({ where: { username: dto.username } });
      if (dup && dup.id !== targetId) {
        throw new ConflictException('Username already taken');
      }
      target.username = dto.username;
    }
    if (dto.email !== undefined) target.email = dto.email;
    if (dto.password !== undefined) {
      target.passwordHash = await bcrypt.hash(dto.password, 12);
    }

    // Admin-only fields
    if (isAdmin) {
      if (dto.role !== undefined) target.role = dto.role as UserRole;
      if (dto.enabled !== undefined) target.enabled = dto.enabled;
    } else if (dto.role !== undefined || dto.enabled !== undefined) {
      throw new ForbiddenException('Only admins can change role or enabled status');
    }

    if (dto.movieQuotaLimit !== undefined) target.movieQuotaLimit = dto.movieQuotaLimit;
    if (dto.seriesQuotaLimit !== undefined) target.seriesQuotaLimit = dto.seriesQuotaLimit;
    if (dto.quotaPeriodDays !== undefined) target.quotaPeriodDays = dto.quotaPeriodDays;

    return this.userRepo.save(target);
  }

  async remove(id: number): Promise<void> {
    const user = await this.findOne(id);
    await this.userRepo.remove(user);
  }

  async regenerateApiKey(id: number, requester: User): Promise<User> {
    const target = await this.findOne(id);
    if (requester.id !== id && requester.role !== UserRole.ADMIN) {
      throw new ForbiddenException();
    }
    target.apiKey = randomBytes(32).toString('hex');
    return this.userRepo.save(target);
  }
}
