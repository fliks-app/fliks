import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { Role } from '../roles/entities/role.entity';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import { Action } from '../auth/casl/actions.enum';

/** API shape: user without password hash, with role name instead of relation. */
export type PublicUser = Omit<User, 'passwordHash' | 'userRole'> & {
  role: string | null;
  permissions: string[];
};

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly log = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    private readonly caslAbilityFactory: CaslAbilityFactory,
  ) {}

  async onModuleInit() {
    const count = await this.userRepo.count();
    if (count > 0) return;

    this.log.warn(
      'No users found — creating default admin account (admin / password)',
    );
    const user = this.userRepo.create({
      username: 'admin',
      passwordHash: await bcrypt.hash('password', 12),
      isAdmin: true,
      enabled: true,
    });
    await this.userRepo.save(user);
    this.log.warn(
      'Default admin account created — change the password after first login!',
    );
  }

  async findAll(): Promise<PublicUser[]> {
    const users = await this.userRepo.find({
      order: { username: 'ASC' },
      relations: ['userRole'],
    });
    return users.map((u) => this.serialize(u));
  }

  async findOne(id: number): Promise<PublicUser> {
    const user = await this.userRepo.findOne({
      where: { id },
      relations: ['userRole'],
    });
    if (!user) throw new NotFoundException(`User #${id} not found`);
    return this.serialize(user);
  }

  /** Flatten userRole into a role name + strip passwordHash. */
  private serialize(user: User): PublicUser {
    const { passwordHash, userRole, ...rest } = user;
    void passwordHash;
    return {
      ...rest,
      role: userRole?.name ?? null,
      permissions: user.permissions,
    };
  }

  async create(dto: CreateUserDto): Promise<PublicUser> {
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
  ): Promise<PublicUser> {
    const target = await this.userRepo.findOne({
      where: { id: targetId },
      relations: ['userRole'],
    });
    if (!target) throw new NotFoundException(`User #${targetId} not found`);
    const isSelf = requester.id === targetId;
    const ability = this.caslAbilityFactory.createForUser(requester);
    const isManager = ability.can(Action.Manage, User);

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
    } else if (
      dto.roleId !== undefined ||
      dto.enabled !== undefined ||
      dto.isAdmin !== undefined
    ) {
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
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User #${id} not found`);
    await this.userRepo.remove(user);
  }
}
