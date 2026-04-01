import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Res,
  Sse,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as fs from 'fs';
import { Indexer } from '../indexers/entities/indexer.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import { QbittorrentService } from '../download-clients/qbittorrent.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { BackupService } from './backup.service';
import { LogBufferService } from './log-buffer.service';
import { EventsService } from './events.service';
import { ImportRadarrService, ApiImportResult } from './import-radarr.service';
import { ImportSonarrService } from './import-sonarr.service';
import { ImportApiDto } from './dto/import-api.dto';
import { Observable } from 'rxjs';

export interface ServiceStatus {
  name: string;
  ok: boolean;
  message?: string;
}

export interface HealthReport {
  version: string;
  uptimeSeconds: number;
  database: ServiceStatus;
  indexers: { enabled: number; total: number };
  downloadClients: ServiceStatus[];
}

export interface DiskSpaceEntry {
  path: string;
  label: string | null;
  freeSpace: number;
  totalSpace: number;
}

export interface StatsReport {
  movies: number;
  series: number;
  pendingRequests: number;
  diskSpace: DiskSpaceEntry[];
}

@Controller('system')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class SystemController {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
    @InjectRepository(DownloadClient)
    private readonly clientRepo: Repository<DownloadClient>,
    @InjectRepository(RootFolder)
    private readonly rootFolderRepo: Repository<RootFolder>,
    private readonly qbittorrent: QbittorrentService,
    private readonly backup: BackupService,
    private readonly logBuffer: LogBufferService,
    private readonly eventsService: EventsService,
    private readonly importRadarrService: ImportRadarrService,
    private readonly importSonarrService: ImportSonarrService,
  ) {}

  @Sse('events')
  events(): Observable<MessageEvent> {
    return this.eventsService.getStream();
  }

  @Get('health')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async health(): Promise<HealthReport> {
    const [dbStatus, indexers, clients] = await Promise.all([
      this.checkDatabase(),
      this.checkIndexers(),
      this.checkClients(),
    ]);

    return {
      version: process.env.npm_package_version ?? '0.1.0',
      uptimeSeconds: Math.floor(process.uptime()),
      database: dbStatus,
      indexers,
      downloadClients: clients,
    };
  }

  private async checkDatabase(): Promise<ServiceStatus> {
    try {
      await this.dataSource.query('SELECT 1');
      return { name: 'PostgreSQL', ok: true };
    } catch (e) {
      return { name: 'PostgreSQL', ok: false, message: (e as Error).message };
    }
  }

  private async checkIndexers(): Promise<{ enabled: number; total: number }> {
    const [enabled, total] = await Promise.all([
      this.indexerRepo.count({ where: { enabled: true } }),
      this.indexerRepo.count(),
    ]);
    return { enabled, total };
  }

  @Get('stats')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async stats(): Promise<StatsReport> {
    const [[moviesRow], [seriesRow], [pendingRow], rootFolders] =
      await Promise.all([
        this.dataSource.query(
          `SELECT COUNT(*)::int AS count FROM media WHERE type = 'movie'`,
        ),
        this.dataSource.query(
          `SELECT COUNT(*)::int AS count FROM media WHERE type = 'series'`,
        ),
        this.dataSource.query(
          `SELECT COUNT(*)::int AS count FROM requests WHERE status = 'pending'`,
        ),
        this.rootFolderRepo.find({ order: { path: 'ASC' } }),
      ]);

    const diskSpace: DiskSpaceEntry[] = rootFolders.map((f) => {
      try {
        const stat = fs.statfsSync(f.path);
        return {
          path: f.path,
          label: f.label ?? null,
          freeSpace: stat.bfree * stat.bsize,
          totalSpace: stat.blocks * stat.bsize,
        };
      } catch {
        return {
          path: f.path,
          label: f.label ?? null,
          freeSpace: -1,
          totalSpace: -1,
        };
      }
    });

    return {
      movies: moviesRow.count,
      series: seriesRow.count,
      pendingRequests: pendingRow.count,
      diskSpace,
    };
  }

  @Post('backup')
  @CheckPolicies((ability) => ability.can(Action.Create, 'Settings'))
  createBackup() {
    return this.backup.createBackup();
  }

  @Get('backups')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  listBackups() {
    return this.backup.listBackups();
  }

  @Post('restore')
  @CheckPolicies((ability) => ability.can(Action.Create, 'Settings'))
  restore(@Body() body: { filename: string }) {
    return this.backup.restore(body.filename);
  }

  @Get('backups/:name')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  downloadBackup(@Param('name') name: string, @Res() res: Response) {
    const filePath = this.backup.getBackupPath(name);
    res.download(filePath, name);
  }

  @Get('logs')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  getLogs(
    @Query('level') level?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.logBuffer.getEntries({
      level: level || undefined,
      q: q || undefined,
      limit: limit ? parseInt(limit, 10) : 200,
    });
  }

  @Post('import-radarr')
  @CheckPolicies((ability) => ability.can(Action.Create, 'Settings'))
  @UseInterceptors(FileInterceptor('file'))
  importRadarr(@UploadedFile() file: Express.Multer.File) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file uploaded');
    }
    return this.importRadarrService.importFromDump(file.buffer);
  }

  @Post('import-sonarr')
  @CheckPolicies((ability) => ability.can(Action.Create, 'Settings'))
  @UseInterceptors(FileInterceptor('file'))
  importSonarr(@UploadedFile() file: Express.Multer.File) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file uploaded');
    }
    return this.importSonarrService.importFromDump(file.buffer);
  }

  @Post('import-radarr-api')
  @CheckPolicies((ability) => ability.can(Action.Create, 'Settings'))
  importRadarrApi(@Body() dto: ImportApiDto): Promise<ApiImportResult> {
    return this.importRadarrService.importFromApi(dto.url, dto.apiKey);
  }

  @Post('import-sonarr-api')
  @CheckPolicies((ability) => ability.can(Action.Create, 'Settings'))
  importSonarrApi(@Body() dto: ImportApiDto): Promise<ApiImportResult> {
    return this.importSonarrService.importFromApi(dto.url, dto.apiKey);
  }

  private async checkClients(): Promise<ServiceStatus[]> {
    const clients = await this.clientRepo.find({ where: { enabled: true } });
    return Promise.all(
      clients.map(async (c) => {
        const result = await this.qbittorrent.testConnection(c.settings);
        return {
          name: c.name,
          ok: result.ok,
          message: result.ok ? undefined : result.message,
        };
      }),
    );
  }
}
