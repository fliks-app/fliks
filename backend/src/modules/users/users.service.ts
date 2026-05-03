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
import { LibraryUserAccess } from '../libraries/entities/library-user-access.entity';
import { Library } from '../libraries/entities/library.entity';

/** API shape: user without password hash, with role name instead of relation. */
export type PublicUser = Omit<User, 'passwordHash' | 'userRole'> & {
  role: string | null;
  permissions: string[];
  /** IDs of libraries the user currently has access to. */
  libraryIds: number[];
};

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly log = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(LibraryUserAccess)
    private readonly libraryAccessRepo: Repository<LibraryUserAccess>,
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
    if (!users.length) return [];
    const accessRows = await this.libraryAccessRepo
      .createQueryBuilder('lua')
      .select(['lua."userId" AS "userId"', 'lua."libraryId" AS "libraryId"'])
      .where('lua."userId" IN (:...ids)', { ids: users.map((u) => u.id) })
      .getRawMany<{ userId: number; libraryId: number }>();
    const byUser = new Map<number, number[]>();
    for (const r of accessRows) {
      const arr = byUser.get(r.userId) ?? [];
      arr.push(r.libraryId);
      byUser.set(r.userId, arr);
    }
    return users.map((u) => this.serialize(u, byUser.get(u.id) ?? []));
  }

  async findOne(id: number): Promise<PublicUser> {
    const user = await this.userRepo.findOne({
      where: { id },
      relations: ['userRole'],
    });
    if (!user) throw new NotFoundException(`User #${id} not found`);
    const libraryIds = await this.loadLibraryIdsForUser(id);
    return this.serialize(user, libraryIds);
  }

  private async loadLibraryIdsForUser(userId: number): Promise<number[]> {
    const rows = await this.libraryAccessRepo
      .createQueryBuilder('lua')
      .select('lua."libraryId"', 'libraryId')
      .where('lua."userId" = :userId', { userId })
      .getRawMany<{ libraryId: number }>();
    return rows.map((r) => r.libraryId);
  }

  /** Flatten userRole into a role name + strip passwordHash. */
  private serialize(user: User, libraryIds: number[]): PublicUser {
    const { passwordHash, userRole, ...rest } = user;
    void passwordHash;
    return {
      ...rest,
      role: userRole?.name ?? null,
      permissions: user.permissions,
      libraryIds,
    };
  }

  async create(dto: CreateUserDto): Promise<PublicUser> {
    const existing = await this.userRepo.findOne({
      where: { username: dto.username },
    });
    if (existing) throw new ConflictException('Username already taken');

    let roleId = dto.roleId;
    let role: Role | null = null;
    if (roleId) {
      role = await this.roleRepo.findOne({ where: { id: roleId } });
    }
    if (!role) {
      role = await this.roleRepo.findOne({ where: { isDefault: true } });
      roleId = role?.id;
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

    // Library access: explicit list from DTO if provided, else seed from
    // the role's defaultLibraryIds template.
    const initialLibraryIds =
      dto.libraryIds !== undefined
        ? dto.libraryIds
        : (role?.defaultLibraryIds ?? []);
    if (initialLibraryIds.length) {
      await this.libraryAccessRepo.save(
        initialLibraryIds.map((libraryId) =>
          this.libraryAccessRepo.create({
            user: saved,
            library: { id: libraryId } as Library,
          }),
        ),
      );
    }

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
      // The user changing their own password clears the forced-change flag —
      // that's how they get out of the gated state. An admin updating someone
      // else's password leaves the flag as-is (the admin must clear it
      // explicitly via the toggle below).
      if (isSelf) target.requirePasswordChange = false;
    }

    // Manager-only fields
    if (isManager) {
      if (dto.roleId !== undefined) {
        target.roleId = dto.roleId;
        // Sync the eager-loaded relation too — otherwise TypeORM rewrites the
        // FK from the old `userRole.id` during `save()`, silently undoing the
        // role change.
        target.userRole = dto.roleId ? ({ id: dto.roleId } as Role) : null;
      }
      if (dto.isAdmin !== undefined) target.isAdmin = dto.isAdmin;
      if (dto.enabled !== undefined) target.enabled = dto.enabled;
      if (dto.requirePasswordChange !== undefined) {
        target.requirePasswordChange = dto.requirePasswordChange;
      }
    } else if (
      dto.roleId !== undefined ||
      dto.enabled !== undefined ||
      dto.isAdmin !== undefined ||
      dto.requirePasswordChange !== undefined
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

    // Library access replace (manager-only). Done after the user row save so
    // FK is valid even for newly-promoted users.
    if (dto.libraryIds !== undefined) {
      if (!isManager) {
        throw new ForbiddenException(
          'Only users with users.manage permission can change library access',
        );
      }
      await this.libraryAccessRepo.delete({ user: { id: targetId } });
      if (dto.libraryIds.length) {
        await this.libraryAccessRepo.save(
          dto.libraryIds.map((libraryId) =>
            this.libraryAccessRepo.create({
              user: { id: targetId } as User,
              library: { id: libraryId } as Library,
            }),
          ),
        );
      }
    }

    return this.findOne(targetId);
  }

  async remove(id: number): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User #${id} not found`);
    await this.userRepo.remove(user);
  }
}
