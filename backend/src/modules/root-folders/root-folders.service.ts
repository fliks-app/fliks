import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import { RootFolder } from './entities/root-folder.entity';
import { CreateRootFolderDto } from './dto/create-root-folder.dto';

@Injectable()
export class RootFoldersService {
  constructor(
    @InjectRepository(RootFolder)
    private readonly repo: Repository<RootFolder>,
  ) {}

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
    const folders = await this.repo.find({ order: { path: 'ASC' } });
    return folders.map((f) => this.enrich(f));
  }

  async findOne(id: number): Promise<ReturnType<typeof this.enrich>> {
    const folder = await this.repo.findOne({ where: { id } });
    if (!folder) throw new NotFoundException(`Root folder #${id} not found`);
    return this.enrich(folder);
  }

  async remove(id: number): Promise<void> {
    const folder = await this.repo.findOne({ where: { id } });
    if (!folder) throw new NotFoundException(`Root folder #${id} not found`);
    await this.repo.remove(folder);
  }
}
