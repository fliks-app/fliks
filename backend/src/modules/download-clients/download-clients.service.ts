import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DownloadClient } from './entities/download-client.entity';
import { DownloadHistory } from '../media/entities/download-history.entity';
import { Media } from '../media/entities/media.entity';
import { QbittorrentService, QbittorrentTorrent } from './qbittorrent.service';
import { CreateDownloadClientDto } from './dto/create-download-client.dto';
import { UpdateDownloadClientDto } from './dto/update-download-client.dto';
import { TestDownloadClientDto } from './dto/test-download-client.dto';
import { TorrentHistoryMatcher } from '../media/torrent-history-matcher.service';
import { BlocklistService } from '../blocklist/blocklist.service';
import { enqueueCommand } from '../../common/utils/command-queue.util';

export interface QueueEntry extends QbittorrentTorrent {
  clientId: number;
  clientName: string;
  mediaId?: number;
  mediaTitle?: string;
  mediaType?: 'movie' | 'series';
  /** Resolved season (single-episode grabs include the parent season,
   *  season packs include just this). */
  seasonNumber?: number;
  /** Resolved episode (single-episode grabs only — packs leave it
   *  unset). */
  episodeNumber?: number;
  /** Episode title where known. */
  episodeTitle?: string | null;
  /** Indexer the torrent was grabbed from (resolved through DownloadHistory). */
  indexerName?: string;
  /** Download client status (Downloading, Seeding, Paused, Stalled…) */
  trackerStatus: string;
  /** App-level status (Awaiting import, Importing, Imported, Import failed…) */
  status: string;
  statusMessage?: string;
}

export interface QueueResult {
  items: QueueEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface QueueQuery {
  page?: number;
  pageSize?: number;
  /** Filter on the mapped download-client status (e.g. "Downloading"). */
  torrentStatus?: string;
  /** Filter on the app-level status (e.g. "Imported"). */
  fliksStatus?: string;
  /** Case-insensitive substring match on the release name or media title. */
  search?: string;
}

const QUEUE_PAGE_SIZE_DEFAULT = 20;
const QUEUE_PAGE_SIZE_MAX = 100;

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
    @InjectRepository(DownloadHistory)
    private readonly historyRepo: Repository<DownloadHistory>,
    private readonly qbittorrent: QbittorrentService,
    private readonly historyMatcher: TorrentHistoryMatcher,
    private readonly blocklist: BlocklistService,
    private readonly dataSource: DataSource,
  ) {}

  async testConnection(
    dto: TestDownloadClientDto,
  ): Promise<{ ok: boolean; message: string }> {
    return this.qbittorrent.testConnection(dto.settings);
  }

  async create(dto: CreateDownloadClientDto): Promise<DownloadClient> {
    const row = this.repo.create({
      name: dto.name,
      implementation: dto.implementation,
      settings: dto.settings ?? {},
      enabled: dto.enabled ?? true,
      priority: dto.priority ?? 1,
    });
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
    if (dto.name !== undefined) dc.name = dto.name;
    if (dto.implementation !== undefined)
      dc.implementation = dto.implementation;
    if (dto.settings !== undefined) dc.settings = dto.settings;
    if (dto.enabled !== undefined) dc.enabled = dto.enabled;
    if (dto.priority !== undefined) dc.priority = dto.priority;
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

  /**
   * Blocklist a torrent's release so it can't be grabbed again, remove it
   * (with its files) from the client, mark the history row failed, and queue
   * a scoped SearchMissing for its media. The re-grab is best-effort and only
   * acts when the configured rules allow it (media monitored, has a profile,
   * still missing) — SearchMissing classifies and skips otherwise, and the
   * blocklist row excludes the release we just removed.
   */
  async blockTorrent(clientId: number, hash: string): Promise<void> {
    const client = await this.findOne(clientId);
    if (!this.qbittorrent.supports(client)) {
      throw new NotFoundException('Client does not support torrent deletion');
    }

    const entry = await this.findHistoryByHash(hash);
    if (entry) {
      try {
        await this.blocklist.createFromHistory(
          entry,
          'Blocked from the activity queue',
        );
      } catch {
        // Already blocklisted — fine, continue with removal.
      }
    }

    await this.qbittorrent.deleteTorrent(client, hash, true);

    if (entry) {
      await this.historyRepo.update(entry.id, {
        status: 'failed',
        statusMessage: 'Blocked from the activity queue',
      });
    }

    // Potentially re-grab a replacement per the configured rules: queue a
    // scoped SearchMissing. The scheduler decides whether anything is grabbed
    // (monitored + profiled + missing), and the blocklist row excludes the
    // release we just removed.
    if (entry?.mediaId) {
      await enqueueCommand(this.dataSource, 'SearchMissing', {
        mediaIds: [entry.mediaId],
      });
    }
  }

  /** Resolve a DownloadHistory row from a torrent hash, falling back to a
   *  name match across enabled clients when the hash isn't stored yet. */
  private async findHistoryByHash(
    hash: string,
  ): Promise<DownloadHistory | null> {
    const byHash = await this.historyRepo.findOne({
      where: { torrentHash: hash },
      order: { createdAt: 'DESC' },
    });
    if (byHash) return byHash;

    const clients = await this.repo.find({ where: { enabled: true } });
    for (const client of clients) {
      if (!this.qbittorrent.supports(client)) continue;
      try {
        const torrents = await this.qbittorrent.getTorrents(client);
        const t = torrents.find(
          (t) => t.hash?.toLowerCase() === hash.toLowerCase(),
        );
        if (t) {
          return this.historyRepo.findOne({
            where: { sourceTitle: t.name },
            order: { createdAt: 'DESC' },
          });
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async linkTorrentToMedia(
    mediaId: number,
    torrentHash: string,
  ): Promise<DownloadHistory> {
    const hash = torrentHash.toLowerCase();

    // Find the torrent in qBittorrent to get name and client
    let sourceTitle = hash;
    let clientId: number | undefined;
    const clients = await this.repo.find({ where: { enabled: true } });
    for (const client of clients) {
      if (!this.qbittorrent.supports(client)) continue;
      try {
        const torrents = await this.qbittorrent.getTorrents(client);
        const t = torrents.find((t) => t.hash?.toLowerCase() === hash);
        if (t) {
          sourceTitle = t.name;
          clientId = client.id;
          break;
        }
      } catch {
        continue;
      }
    }

    return this.historyRepo.save(
      this.historyRepo.create({
        media: { id: mediaId } as Media,
        sourceTitle,
        downloadClient: clientId ? ({ id: clientId } as DownloadClient) : null,
        torrentHash: hash,
        quality: this.parseQuality(sourceTitle),
        status: 'grabbed',
        grabSource: 'manual',
      }),
    );
  }

  private parseQuality(title: string): string {
    const u = title.toUpperCase();
    if (u.includes('2160P') || u.includes('4K') || u.includes('UHD'))
      return '2160p';
    if (u.includes('1080P')) return '1080p';
    if (u.includes('720P')) return '720p';
    if (u.includes('480P')) return '480p';
    if (u.includes('REMUX')) return 'Remux';
    if (u.includes('BLURAY') || u.includes('BLU-RAY')) return 'Bluray';
    if (u.includes('WEBRIP')) return 'WEBRip';
    if (u.includes('WEB-DL') || u.includes('WEBDL')) return 'WEB-DL';
    if (u.includes('WEB')) return 'WEB';
    if (u.includes('HDTV')) return 'HDTV';
    return '';
  }

  async reimport(torrentHash: string): Promise<void> {
    let entry = await this.historyRepo.findOne({
      where: { torrentHash },
      order: { createdAt: 'DESC' },
    });

    // Fallback: find by torrent name (hash may not have been resolved at link time)
    if (!entry) {
      const clients = await this.repo.find({ where: { enabled: true } });
      for (const client of clients) {
        if (!this.qbittorrent.supports(client)) continue;
        try {
          const torrents = await this.qbittorrent.getTorrents(client);
          const t = torrents.find(
            (t) => t.hash?.toLowerCase() === torrentHash.toLowerCase(),
          );
          if (t) {
            entry = await this.historyRepo.findOne({
              where: { sourceTitle: t.name },
              order: { createdAt: 'DESC' },
            });
            if (entry) {
              // Patch the hash for future lookups
              entry.torrentHash = torrentHash;
            }
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (!entry) {
      throw new NotFoundException(
        'No history entry — link the torrent to a media first',
      );
    }
    await this.historyRepo.update(entry.id, {
      torrentHash: entry.torrentHash,
      status: 'grabbed',
      statusMessage: null as any,
    });
  }

  async getQueue(query: QueueQuery = {}): Promise<QueueResult> {
    const pageSize = Math.min(
      Math.max(query.pageSize ?? QUEUE_PAGE_SIZE_DEFAULT, 1),
      QUEUE_PAGE_SIZE_MAX,
    );
    const page = Math.max(query.page ?? 1, 1);
    const empty: QueueResult = { items: [], total: 0, page, pageSize };

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
          trackerStatus: QB_STATE_MAP[t.state] ?? t.state,
          status: '',
        });
      }
    }

    if (results.length === 0) return empty;

    // Match queue items with history entries to find mediaId & import status
    const historyEntries = await this.historyRepo.find({
      where: [
        { status: 'grabbed' },
        { status: 'failed' },
        { status: 'importing' },
        { status: 'completed' },
        { status: 'warning' },
      ],
      relations: ['media', 'indexer', 'episode', 'season'],
    });

    for (const entry of results) {
      const match = await this.historyMatcher.matchAndHeal(
        entry,
        historyEntries,
      );
      if (match?.media) {
        entry.mediaId = match.mediaId;
        entry.mediaTitle = match.media.title;
        entry.mediaType = match.media.type;
      }
      if (match?.indexer) {
        entry.indexerName = match.indexer.name;
      }
      // Surface the resolved season / episode so the Activities row can
      // render "Show — S01E03" or "Show — Saison 1" without joining
      // back through the files. Single-episode grabs always include
      // both fields; season packs include only `seasonNumber`.
      if (match?.episode) {
        entry.episodeNumber = match.episode.episodeNumber;
        entry.episodeTitle = match.episode.title ?? null;
      }
      if (match?.season) {
        entry.seasonNumber = match.season.seasonNumber;
      }

      // App-level status from history
      if (match) {
        if (match.status === 'completed') {
          entry.status = 'Imported';
        } else if (match.status === 'importing') {
          entry.status = 'Importing';
        } else if (match.status === 'failed') {
          entry.status = 'Import failed';
          entry.statusMessage = match.statusMessage ?? undefined;
        } else if (match.status === 'warning') {
          entry.status = 'Quality not upgraded';
          entry.statusMessage = match.statusMessage ?? undefined;
        } else if (entry.progress >= 1) {
          entry.status = 'Awaiting import';
        }
      }
    }

    // Filter on the resolved statuses, then sort newest-first so pagination
    // is stable across the 10s client poll, then page.
    let filtered = results;
    if (query.torrentStatus) {
      filtered = filtered.filter(
        (r) => r.trackerStatus === query.torrentStatus,
      );
    }
    if (query.fliksStatus) {
      filtered = filtered.filter((r) => r.status === query.fliksStatus);
    }
    if (query.search) {
      const needle = query.search.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.name.toLowerCase().includes(needle) ||
          (r.mediaTitle?.toLowerCase().includes(needle) ?? false),
      );
    }
    filtered.sort((a, b) => (b.added_on ?? 0) - (a.added_on ?? 0));

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    return {
      items: filtered.slice(start, start + pageSize),
      total,
      page,
      pageSize,
    };
  }
}
