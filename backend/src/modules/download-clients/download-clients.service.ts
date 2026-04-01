import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DownloadClient } from './entities/download-client.entity';
import { Tag } from '../tags/entities/tag.entity';
import { DownloadHistory } from '../media/entities/download-history.entity';
import { QbittorrentService, QbittorrentTorrent } from './qbittorrent.service';
import { CreateDownloadClientDto } from './dto/create-download-client.dto';
import { UpdateDownloadClientDto } from './dto/update-download-client.dto';
import { TestDownloadClientDto } from './dto/test-download-client.dto';

export interface QueueEntry extends QbittorrentTorrent {
  clientId: number;
  clientName: string;
  mediaId?: number;
  mediaTitle?: string;
  mediaType?: 'movie' | 'series';
  status: string;
  statusMessage?: string;
}

const QB_STATE_MAP: Record<string, string> = {
  error: 'Error',
  missingFiles: 'Missing files',
  uploading: 'Seeding',
  pausedUP: 'Paused',
  queuedUP: 'Queued',
  stalledUP: 'Seeding',
  checkingUP: 'Checking',
  forcedUP: 'Seeding',
  allocating: 'Allocating',
  downloading: 'Downloading',
  metaDL: 'Downloading metadata',
  pausedDL: 'Paused',
  queuedDL: 'Queued',
  stalledDL: 'Stalled',
  checkingDL: 'Checking',
  forcedDL: 'Downloading',
  forcedMetaDL: 'Downloading metadata',
  checkingResumeData: 'Checking',
  moving: 'Moving',
  stoppedUP: 'Stopped',
  stoppedDL: 'Stopped',
  unknown: 'Unknown',
};

@Injectable()
export class DownloadClientsService {
  constructor(
    @InjectRepository(DownloadClient)
    private readonly repo: Repository<DownloadClient>,
    @InjectRepository(Tag)
    private readonly tagRepo: Repository<Tag>,
    @InjectRepository(DownloadHistory)
    private readonly historyRepo: Repository<DownloadHistory>,
    private readonly qbittorrent: QbittorrentService,
  ) {}

  async testConnection(
    dto: TestDownloadClientDto,
  ): Promise<{ ok: boolean; message: string }> {
    return this.qbittorrent.testConnection(dto.settings);
  }

  async create(dto: CreateDownloadClientDto): Promise<DownloadClient> {
    const { tagIds, ...fields } = dto;
    const row = this.repo.create({
      name: fields.name,
      implementation: fields.implementation,
      settings: fields.settings ?? {},
      enabled: fields.enabled ?? true,
      priority: fields.priority ?? 1,
    });
    if (tagIds?.length) {
      row.tags = await this.tagRepo.find({ where: { id: In(tagIds) } });
    }
    return this.repo.save(row);
  }

  findAll(): Promise<DownloadClient[]> {
    return this.repo.find({ order: { priority: 'ASC', id: 'ASC' } });
  }

  async findOne(id: number): Promise<DownloadClient> {
    const dc = await this.repo.findOne({ where: { id } });
    if (!dc) throw new NotFoundException(`Download client #${id} not found`);
    return dc;
  }

  async update(
    id: number,
    dto: UpdateDownloadClientDto,
  ): Promise<DownloadClient> {
    const dc = await this.findOne(id);
    const { tagIds, ...patch } = dto;
    if (patch.name !== undefined) dc.name = patch.name;
    if (patch.implementation !== undefined)
      dc.implementation = patch.implementation;
    if (patch.settings !== undefined) dc.settings = patch.settings;
    if (patch.enabled !== undefined) dc.enabled = patch.enabled;
    if (patch.priority !== undefined) dc.priority = patch.priority;
    if (tagIds !== undefined) {
      dc.tags = tagIds.length
        ? await this.tagRepo.find({ where: { id: In(tagIds) } })
        : [];
    }
    return this.repo.save(dc);
  }

  async remove(id: number): Promise<void> {
    const dc = await this.findOne(id);
    await this.repo.remove(dc);
  }

  async removeTorrent(
    clientId: number,
    hash: string,
    deleteFiles: boolean,
  ): Promise<void> {
    const client = await this.findOne(clientId);
    if (!this.qbittorrent.supports(client)) {
      throw new NotFoundException('Client does not support torrent deletion');
    }
    await this.qbittorrent.deleteTorrent(client, hash, deleteFiles);
  }

  async reimport(torrentHash: string): Promise<void> {
    const entry = await this.historyRepo.findOne({
      where: { torrentHash, status: 'completed' as any },
    });
    if (!entry) {
      // Try matching by name
      const entries = await this.historyRepo.find({
        where: [{ status: 'completed' as any }, { status: 'warning' as any }],
      });
      const match = entries.find(
        (h) => h.torrentHash === torrentHash,
      );
      if (match) {
        await this.historyRepo.update(match.id, {
          status: 'grabbed',
          statusMessage: null as any,
        });
        return;
      }
      throw new NotFoundException('No completed history entry found for this torrent');
    }
    await this.historyRepo.update(entry.id, {
      status: 'grabbed',
      statusMessage: null as any,
    });
  }

  async getQueue(): Promise<QueueEntry[]> {
    const clients = await this.repo.find({ where: { enabled: true } });
    const results: QueueEntry[] = [];
    for (const client of clients) {
      if (!this.qbittorrent.supports(client)) continue;
      const torrents = await this.qbittorrent.getTorrents(client);
      for (const t of torrents) {
        results.push({
          ...t,
          clientId: client.id,
          clientName: client.name,
          status: QB_STATE_MAP[t.state] ?? t.state,
        });
      }
    }

    if (results.length === 0) return results;

    // Match queue items with history entries to find mediaId & import status
    const historyEntries = await this.historyRepo.find({
      where: [
        { status: 'grabbed' },
        { status: 'failed' },
        { status: 'importing' },
        { status: 'completed' },
        { status: 'warning' },
      ],
      relations: ['media'],
    });

    for (const entry of results) {
      const hash = entry.hash?.toLowerCase();
      const name = entry.name.toLowerCase();

      const match =
        historyEntries.find((h) => h.torrentHash && h.torrentHash === hash) ??
        historyEntries.find(
          (h) =>
            h.sourceTitle.toLowerCase() === name ||
            name.startsWith(h.sourceTitle.toLowerCase()),
        );
      if (match?.media) {
        entry.mediaId = match.mediaId;
        entry.mediaTitle = match.media.title;
        entry.mediaType = match.media.type;
      }

      // Override status for seeding torrents waiting for import
      const isSeeding = entry.status === 'Seeding';
      if (isSeeding && match) {
        if (match.status === 'warning') {
          entry.status = 'Quality not upgraded';
          entry.statusMessage = match.statusMessage ?? undefined;
        } else if (match.status === 'failed') {
          entry.status = 'Import failed';
          entry.statusMessage = match.statusMessage ?? undefined;
        } else if (match.status === 'importing') {
          entry.status = 'Importing';
        } else if (match.status === 'completed') {
          entry.status = 'Imported';
        } else {
          entry.status = 'Awaiting import';
        }
      }
    }

    return results;
  }
}
