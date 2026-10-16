import {
  Controller,
  Delete,
  Get,
  Logger,
  Post,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as fs from 'fs';
import { Library } from '../libraries/entities/library.entity';
import { PluginPackage } from '../plugins/entities/plugin-package.entity';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { BackupService } from './backup.service';
import { LogBufferService } from './log-buffer.service';
import { UpdateCheckService, type UpdateStatus } from './update-check.service';
import { FliksRequest } from '../requests/entities/request.entity';
import { RequestStatus } from '../../common/enums';
import { CURRENT_FLIKS_VERSION } from '../plugins/plugin-version';

const APP_VERSION = CURRENT_FLIKS_VERSION;

export interface ServiceStatus {
  name: string;
  ok: boolean;
  message?: string;
}

export interface HealthReport {
  version: string;
  uptimeSeconds: number;
  database: ServiceStatus;
  /** Core reports only how many plugins are installed. A capability's own
   *  reachability belongs on that capability's page, which its plugin owns. */
  installedPlugins: number;
  /** Enabled, not necessarily reachable — same scope limit as `installedPlugins`. */
  runningPlugins: number;
  restartSupervisor: string | null;
}

function detectRestartSupervisor(): string | null {
  if (process.env.FLIKS_SUPERVISED) return 'supervisor';
  if (process.env.pm_id) return 'pm2';
  if (process.env.INVOCATION_ID) return 'systemd';
  if (fs.existsSync('/.dockerenv')) return 'docker';
  return null;
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
  private readonly logger = new Logger(SystemController.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Library)
    private readonly libraryRepo: Repository<Library>,
    @InjectRepository(PluginPackage)
    private readonly pluginPackageRepo: Repository<PluginPackage>,
    private readonly backup: BackupService,
    private readonly logBuffer: LogBufferService,
    @InjectRepository(FliksRequest)
    private readonly requestRepo: Repository<FliksRequest>,
    private readonly updateCheck: UpdateCheckService,
  ) {}

  @Get('health')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async health(): Promise<HealthReport> {
    return {
      version: APP_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      database: await this.checkDatabase(),
      installedPlugins: await this.pluginPackageRepo.count(),
      runningPlugins: await this.pluginPackageRepo.count({
        where: { enabled: true },
      }),
      restartSupervisor: detectRestartSupervisor(),
    };
  }

  @Post('restart')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  restart(): { ok: true; supervisor: string } {
    const supervisor = detectRestartSupervisor();
    if (!supervisor) {
      throw new BadRequestException('No process supervisor detected');
    }
    this.logger.warn(`Restart requested (supervisor: ${supervisor})`);
    // In a container PID 1 must exit, else the `npm run` wrapper outlives us.
    const target = supervisor === 'docker' ? 1 : process.pid;
    process.exitCode = 1;
    setTimeout(() => process.kill(target, 'SIGTERM'), 300);
    return { ok: true, supervisor };
  }

  /** Any signed-in client: the desktop app compares its own update against it. */
  @Get('version')
  @CheckPolicies(() => true)
  version(): { version: string } {
    return { version: APP_VERSION };
  }

  @Get('update')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async update(): Promise<UpdateStatus> {
    return this.updateCheck.getStatus();
  }

  private async checkDatabase(): Promise<ServiceStatus> {
    try {
      await this.dataSource.query('SELECT 1');
      return { name: 'PostgreSQL', ok: true };
    } catch (e) {
      return { name: 'PostgreSQL', ok: false, message: (e as Error).message };
    }
  }

  @Get('stats')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async stats(): Promise<StatsReport> {
    const [[moviesRow], [seriesRow], pendingRequests, libraries] =
      await Promise.all([
        this.dataSource.query(
          `SELECT COUNT(*)::int AS count FROM media WHERE type = 'movie'`,
        ),
        this.dataSource.query(
          `SELECT COUNT(*)::int AS count FROM media WHERE type = 'series'`,
        ),
        this.requestRepo.count({ where: { status: RequestStatus.PENDING } }),
        this.libraryRepo.find({ order: { name: 'ASC' } }),
      ]);

    const diskSpace: DiskSpaceEntry[] = libraries
      .filter((lib) => !!lib.path)
      .map((lib) => {
        try {
          const stat = fs.statfsSync(lib.path!);
          return {
            path: lib.path!,
            label: lib.label ?? lib.name,
            freeSpace: stat.bfree * stat.bsize,
            totalSpace: stat.blocks * stat.bsize,
          };
        } catch {
          return {
            path: lib.path!,
            label: lib.label ?? lib.name,
            freeSpace: -1,
            totalSpace: -1,
          };
        }
      });

    return {
      movies: moviesRow.count,
      series: seriesRow.count,
      pendingRequests,
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

  @Delete('backups/:name')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  deleteBackup(@Param('name') name: string): { ok: true } {
    this.backup.deleteBackup(name);
    return { ok: true };
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
}
