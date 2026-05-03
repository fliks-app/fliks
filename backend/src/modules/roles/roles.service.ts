import {
  Injectable,
  NotFoundException,
  ConflictException,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Role } from './entities/role.entity';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { DEFAULT_ROLES, PERMISSIONS } from '../../common/constants/permissions';
import { User } from '../users/entities/user.entity';
import { Library } from '../libraries/entities/library.entity';

@Injectable()
export class RolesService implements OnModuleInit {
  private readonly log = new Logger(RolesService.name);

  constructor(
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Library)
    private readonly libraryRepo: Repository<Library>,
  ) {}

  private async loadLibraries(ids?: number[]): Promise<Library[]> {
    if (!ids?.length) return [];
    return this.libraryRepo.find({ where: { id: In(ids) } });
  }

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
  }

  findAll(): Promise<Role[]> {
    return this.roleRepo.find({
      order: { name: 'ASC' },
      relations: ['defaultLibraries'],
    });
  }

  async findOne(id: number): Promise<Role> {
    const role = await this.roleRepo.findOne({
      where: { id },
      relations: ['defaultLibraries'],
    });
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

    const defaultLibraries = await this.loadLibraries(dto.defaultLibraryIds);
    return this.roleRepo.save(
      this.roleRepo.create({
        name: dto.name,
        permissions: dto.permissions,
        isDefault: dto.isDefault ?? false,
        defaultLibraries,
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
    if (dto.defaultLibraryIds !== undefined) {
      role.defaultLibraries = await this.loadLibraries(dto.defaultLibraryIds);
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
