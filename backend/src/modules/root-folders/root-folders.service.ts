import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import { RootFolder } from './entities/root-folder.entity';
import { CreateRootFolderDto } from './dto/create-root-folder.dto';
import { UpdateRootFolderDto } from './dto/update-root-folder.dto';

const SYSTEM_FOLDERS = [
  { label: 'Movies', path: '/medias/movies' },
  { label: 'TV Shows', path: '/medias/tvshows' },
];

@Injectable()
export class RootFoldersService implements OnModuleInit {
  private readonly log = new Logger(RootFoldersService.name);

  constructor(
    @InjectRepository(RootFolder)
    private readonly repo: Repository<RootFolder>,
  ) {}

  async onModuleInit() {
    for (const def of SYSTEM_FOLDERS) {
      const existing = await this.repo.findOne({
        where: { label: def.label, system: true },
      });
      if (!existing) {
        try {
          fs.mkdirSync(def.path, { recursive: true });
        } catch {
          // ignore if path creation fails
        }
        await this.repo.save(
          this.repo.create({ path: def.path, label: def.label, system: true }),
        );
        this.log.log(`Created system root folder: ${def.label} → ${def.path}`);
      }
    }
  }

  private diskInfo(path: string): { freeSpace: number; totalSpace: number } {
    try {
      const stats = fs.statfsSync(path);
      return {
        freeSpace: stats.bfree * stats.bsize,
        totalSpace: stats.blocks * stats.bsize,
      };
    } catch {
      return { freeSpace: -1, totalSpace: -1 };
    }
  }

  private enrich(folder: RootFolder) {
    const disk = this.diskInfo(folder.path);
    return { ...folder, ...disk, accessible: disk.freeSpace !== -1 };
  }

  async create(
    dto: CreateRootFolderDto,
  ): Promise<ReturnType<typeof this.enrich>> {
    if (!fs.existsSync(dto.path)) {
      throw new BadRequestException(
        `Path "${dto.path}" does not exist on the server`,
      );
    }
    const row = this.repo.create({ path: dto.path, label: dto.label });
    const saved = await this.repo.save(row);
    return this.enrich(saved);
  }

  async findAll(): Promise<ReturnType<typeof this.enrich>[]> {
    const folders = await this.repo.find({
      order: { system: 'DESC', path: 'ASC' },
    });
    return folders.map((f) => this.enrich(f));
  }

  async findOne(id: number): Promise<ReturnType<typeof this.enrich>> {
    const folder = await this.repo.findOne({ where: { id } });
    if (!folder) throw new NotFoundException(`Root folder #${id} not found`);
    return this.enrich(folder);
  }

  async update(
    id: number,
    dto: UpdateRootFolderDto,
  ): Promise<ReturnType<typeof this.enrich>> {
    const folder = await this.repo.findOne({ where: { id } });
    if (!folder) throw new NotFoundException(`Root folder #${id} not found`);
    if (dto.path !== undefined) folder.path = dto.path;
    if (dto.label !== undefined) folder.label = dto.label;
    const saved = await this.repo.save(folder);
    return this.enrich(saved);
  }

  async remove(id: number): Promise<void> {
    const folder = await this.repo.findOne({ where: { id } });
    if (!folder) throw new NotFoundException(`Root folder #${id} not found`);
    if (folder.system) {
      throw new BadRequestException('System root folders cannot be deleted');
    }
    await this.repo.remove(folder);
  }
}
