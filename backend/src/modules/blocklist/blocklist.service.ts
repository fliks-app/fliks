import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BlocklistEntry } from './entities/blocklist-entry.entity';
import { CreateBlocklistEntryDto } from './dto/create-blocklist-entry.dto';
import { Indexer } from '../indexers/entities/indexer.entity';
import { Media } from '../media/entities/media.entity';
import { User } from '../users/entities/user.entity';
import { DownloadHistory } from '../media/entities/download-history.entity';

@Injectable()
export class BlocklistService {
  constructor(
    @InjectRepository(BlocklistEntry)
    private readonly repo: Repository<BlocklistEntry>,
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
  ) {}

  async create(dto: CreateBlocklistEntryDto): Promise<BlocklistEntry> {
    const { indexerId, mediaId, userId, ...rest } = dto;
    let indexerName = rest.indexerName;
    if (indexerId && !indexerName) {
      const ix = await this.indexerRepo.findOne({ where: { id: indexerId } });
      indexerName = ix?.name ?? undefined;
    }
    const row = this.repo.create({
      ...rest,
      indexerName,
      indexerId: indexerId ?? null,
      media: mediaId ? ({ id: mediaId } as Media) : null,
      user: userId ? ({ id: userId } as User) : null,
    });
    return this.repo.save(row);
  }

  /** Blocklist the release behind a download-history row. Single source of
   *  truth for the field mapping shared by failed-import, stalled-cleanup and
   *  the manual "block torrent" action. */
  createFromHistory(
    history: DownloadHistory,
    note: string,
  ): Promise<BlocklistEntry> {
    return this.create({
      sourceTitle: history.sourceTitle,
      quality: history.quality ?? undefined,
      mediaId: history.mediaId ?? undefined,
      indexerId: history.indexerId ?? undefined,
      note,
    });
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
