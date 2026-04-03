import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { Role } from '../roles/entities/role.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
  ) {}

  async findAll() {
    const users = await this.userRepo.find({
      order: { username: 'ASC' },
      relations: ['userRole'],
    });
    return users.map((u) => this.serialize(u));
  }

  async findOne(id: number) {
    const user = await this.userRepo.findOne({
      where: { id },
      relations: ['userRole'],
    });
    if (!user) throw new NotFoundException(`User #${id} not found`);
    return this.serialize(user);
  }

  /** Flatten userRole into a role name + strip passwordHash. */
  private serialize(user: User) {
    const { passwordHash, userRole, ...rest } = user as any;
    return {
      ...rest,
      role: user.userRole?.name ?? null,
      permissions: user.permissions,
    };
  }

  async create(dto: CreateUserDto): Promise<User> {
    const existing = await this.userRepo.findOne({
      where: { username: dto.username },
    });
    if (existing) throw new ConflictException('Username already taken');

    let roleId = dto.roleId;
    if (!roleId) {
      const defaultRole = await this.roleRepo.findOne({
        where: { isDefault: true },
      });
      roleId = defaultRole?.id;
    }

    const user = this.userRepo.create({
      username: dto.username,
      passwordHash: await bcrypt.hash(dto.password, 12),
      email: dto.email,
      roleId,
      isAdmin: dto.isAdmin ?? false,
      enabled: dto.enabled ?? true,
    });
    const saved = await this.userRepo.save(user);
    return this.findOne(saved.id);
  }

  /**
   * Admin can update any user.
   * Regular users can only update themselves (no roleId/enabled changes).
   */
  async update(
    targetId: number,
    dto: UpdateUserDto,
    requester: User,
  ): Promise<User> {
    const target = await this.findOne(targetId);
    const isSelf = requester.id === targetId;
    const isManager = requester.permissions.includes('users.manage');

    if (!isSelf && !isManager) throw new ForbiddenException();

    if (dto.username !== undefined) {
      const dup = await this.userRepo.findOne({
        where: { username: dto.username },
      });
      if (dup && dup.id !== targetId) {
        throw new ConflictException('Username already taken');
      }
      target.username = dto.username;
    }
    if (dto.email !== undefined) target.email = dto.email;
    if (dto.password !== undefined) {
      target.passwordHash = await bcrypt.hash(dto.password, 12);
    }

    // Manager-only fields
    if (isManager) {
      if (dto.roleId !== undefined) target.roleId = dto.roleId;
      if (dto.isAdmin !== undefined) target.isAdmin = dto.isAdmin;
      if (dto.enabled !== undefined) target.enabled = dto.enabled;
    } else if (dto.roleId !== undefined || dto.enabled !== undefined || dto.isAdmin !== undefined) {
      throw new ForbiddenException(
        'Only users with users.manage permission can change role or enabled status',
      );
    }

    if (dto.movieQuotaLimit !== undefined)
      target.movieQuotaLimit = dto.movieQuotaLimit;
    if (dto.seriesQuotaLimit !== undefined)
      target.seriesQuotaLimit = dto.seriesQuotaLimit;
    if (dto.quotaPeriodDays !== undefined)
      target.quotaPeriodDays = dto.quotaPeriodDays;

    await this.userRepo.save(target);
    return this.findOne(targetId);
  }

  async remove(id: number): Promise<void> {
    const user = await this.findOne(id);
    await this.userRepo.remove(user);
  }

}
