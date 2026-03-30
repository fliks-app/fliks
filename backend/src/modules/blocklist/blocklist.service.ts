import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BlocklistEntry } from './entities/blocklist-entry.entity';
import { CreateBlocklistEntryDto } from './dto/create-blocklist-entry.dto';

@Injectable()
export class BlocklistService {
  constructor(
    @InjectRepository(BlocklistEntry)
    private readonly repo: Repository<BlocklistEntry>,
  ) {}

  create(dto: CreateBlocklistEntryDto): Promise<BlocklistEntry> {
    const row = this.repo.create(dto);
    return this.repo.save(row);
  }

  async findAll(
    page = 1,
    limit = 25,
  ): Promise<{ data: BlocklistEntry[]; total: number }> {
    const [data, total] = await this.repo.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total };
  }

  isBlocked(sourceTitle: string): Promise<boolean> {
    return this.repo
      .createQueryBuilder('b')
      .where('LOWER(b.sourceTitle) = LOWER(:title)', { title: sourceTitle })
      .getCount()
      .then((c) => c > 0);
  }

  async remove(id: number): Promise<void> {
    const entry = await this.repo.findOne({ where: { id } });
    if (!entry) throw new NotFoundException(`Blocklist entry #${id} not found`);
    await this.repo.remove(entry);
  }

  async clear(): Promise<{ deleted: number }> {
    const result = await this.repo.delete({});
    return { deleted: result.affected ?? 0 };
  }
}
