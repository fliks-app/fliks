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
import { UpdateRootFolderDto } from './dto/update-root-folder.dto';
import { MediaType } from '../../common/enums/media-type.enum';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class RootFoldersService {
  constructor(
    @InjectRepository(RootFolder)
    private readonly repo: Repository<RootFolder>,
    private readonly settings: SettingsService,
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
    const row = this.repo.create({
      path: dto.path,
      label: dto.label,
      mediaTypes: dto.mediaTypes ?? [MediaType.MOVIE, MediaType.SERIES],
      preferredProvider: dto.preferredProvider ?? null,
    });
    const saved = await this.repo.save(row);
    return this.enrich(saved);
  }

  async findAll(): Promise<ReturnType<typeof this.enrich>[]> {
    const folders = await this.repo.find({
      order: { path: 'ASC' },
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
    if (dto.path !== undefined) {
      if (!fs.existsSync(dto.path)) {
        throw new BadRequestException(
          `Path "${dto.path}" does not exist on the server`,
        );
      }
      folder.path = dto.path;
    }
    if (dto.label !== undefined) folder.label = dto.label;
    if (dto.preferredProvider !== undefined) folder.preferredProvider = dto.preferredProvider;
    if (dto.mediaTypes !== undefined) {
      await this.checkDefaultConflict(id, folder.mediaTypes, dto.mediaTypes);
      folder.mediaTypes = dto.mediaTypes;
    }
    const saved = await this.repo.save(folder);
    return this.enrich(saved);
  }

  async remove(id: number): Promise<void> {
    const folder = await this.repo.findOne({ where: { id } });
    if (!folder) throw new NotFoundException(`Root folder #${id} not found`);
    await this.checkDefaultConflict(id, folder.mediaTypes, []);
    await this.repo.remove(folder);
  }

  private async checkDefaultConflict(
    folderId: number,
    currentTypes: MediaType[],
    newTypes: MediaType[],
  ): Promise<void> {
    const idStr = String(folderId);
    const removedTypes = currentTypes.filter((t) => !newTypes.includes(t));
    if (removedTypes.length === 0) return;

    const defaultMovie = await this.settings.get('default_root_folder_movie');
    const defaultSeries = await this.settings.get('default_root_folder_series');

    if (removedTypes.includes(MediaType.MOVIE) && defaultMovie === idStr) {
      throw new BadRequestException(
        'This folder is the default for movies. Change the default before removing the movie type.',
      );
    }
    if (removedTypes.includes(MediaType.SERIES) && defaultSeries === idStr) {
      throw new BadRequestException(
        'This folder is the default for series. Change the default before removing the series type.',
      );
    }
  }
}
