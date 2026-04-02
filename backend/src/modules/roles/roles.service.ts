import {
  Injectable,
  NotFoundException,
  ConflictException,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from './entities/role.entity';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { DEFAULT_ROLES, PERMISSIONS } from '../../common/constants/permissions';
import { User } from '../users/entities/user.entity';

@Injectable()
export class RolesService implements OnModuleInit {
  private readonly log = new Logger(RolesService.name);

  constructor(
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /** Seed default roles & migrate legacy users on startup. */
  async onModuleInit() {
    const count = await this.roleRepo.count();
    if (count === 0) {
      this.log.log('Seeding default roles…');
      for (const [name, permissions] of Object.entries(DEFAULT_ROLES)) {
        await this.roleRepo.save(
          this.roleRepo.create({
            name,
            permissions,
            isDefault: name === 'User',
          }),
        );
      }
    }

    // Migrate legacy users: if user has no roleId, assign based on old role column
    const orphans = await this.userRepo.find({ where: { roleId: null as any } });
    if (orphans.length > 0) {
      const allRoles = await this.roleRepo.find();
      const roleMap = new Map(allRoles.map((r) => [r.name.toLowerCase(), r]));
      for (const user of orphans) {
        const legacyRole = (user as any).role as string | undefined;
        const match =
          roleMap.get(legacyRole ?? 'user') ?? roleMap.get('user');
        if (match) {
          const patch: any = { roleId: match.id };
          // Legacy admin users get the isAdmin flag
          if (legacyRole === 'admin') patch.isAdmin = true;
          await this.userRepo.update(user.id, patch);
          this.log.log(
            `Migrated user "${user.username}" → role "${match.name}"${legacyRole === 'admin' ? ' (isAdmin)' : ''}`,
          );
        }
      }
    }
  }

  findAll(): Promise<Role[]> {
    return this.roleRepo.find({ order: { name: 'ASC' } });
  }

  async findOne(id: number): Promise<Role> {
    const role = await this.roleRepo.findOne({ where: { id } });
    if (!role) throw new NotFoundException(`Role #${id} not found`);
    return role;
  }

  async create(dto: CreateRoleDto): Promise<Role> {
    const dup = await this.roleRepo.findOne({ where: { name: dto.name } });
    if (dup) throw new ConflictException('Role name already exists');

    if (dto.isDefault) {
      await this.roleRepo
        .createQueryBuilder()
        .update()
        .set({ isDefault: false })
        .where('isDefault = true')
        .execute();
    }

    return this.roleRepo.save(
      this.roleRepo.create({
        name: dto.name,
        permissions: dto.permissions,
        isDefault: dto.isDefault ?? false,
      }),
    );
  }

  async update(id: number, dto: UpdateRoleDto): Promise<Role> {
    const role = await this.findOne(id);

    if (dto.name !== undefined && dto.name !== role.name) {
      const dup = await this.roleRepo.findOne({ where: { name: dto.name } });
      if (dup) throw new ConflictException('Role name already exists');
      role.name = dto.name;
    }
    if (dto.permissions !== undefined) role.permissions = dto.permissions;
    if (dto.isDefault !== undefined) {
      if (dto.isDefault) {
        await this.roleRepo
          .createQueryBuilder()
          .update()
          .set({ isDefault: false })
          .where('isDefault = true')
          .execute();
      }
      role.isDefault = dto.isDefault;
    }

    return this.roleRepo.save(role);
  }

  async remove(id: number): Promise<void> {
    const role = await this.findOne(id);
    // Prevent deleting a role that's still assigned to users
    const usersCount = await this.userRepo.count({ where: { roleId: id } });
    if (usersCount > 0) {
      throw new ConflictException(
        `Cannot delete role "${role.name}": still assigned to ${usersCount} user(s)`,
      );
    }
    await this.roleRepo.remove(role);
  }

  /** Return the list of all available permission keys. */
  getAvailablePermissions(): string[] {
    return [...PERMISSIONS];
  }

  async getDefaultRole(): Promise<Role | null> {
    return this.roleRepo.findOne({ where: { isDefault: true } });
  }
}
