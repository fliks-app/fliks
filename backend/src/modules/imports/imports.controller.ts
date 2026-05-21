import { Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { Media } from '../media/entities/media.entity';
import { EventsService } from '../scheduler/events.service';
import { ImportRadarrService, ApiImportResult } from './radarr.service';
import { ImportSonarrService } from './sonarr.service';
import { SeerrService } from './seerr.service';
import { SeerrRequestImportService } from './seerr-request-import.service';
import { DiskImportService } from './disk-import.service';
import { ImportApiDto } from './dto/import-api.dto';
import { TestConnectionDto } from './dto/test-connection.dto';
import { ScanFolderDto } from './dto/scan-folder.dto';
import { ConfirmDiskImportDto } from './dto/confirm-disk-import.dto';
import { PreviewImportDto } from './dto/preview-import.dto';

@Controller('imports')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class ImportsController {
  private readonly log = new Logger(ImportsController.name);

  constructor(
    private readonly importRadarrService: ImportRadarrService,
    private readonly importSonarrService: ImportSonarrService,
    private readonly seerr: SeerrService,
    private readonly seerrImporter: SeerrRequestImportService,
    private readonly diskImport: DiskImportService,
    private readonly events: EventsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Radarr
  // ---------------------------------------------------------------------------

  @Post('radarr/test')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  testRadarrConnection(@Body() dto: TestConnectionDto) {
    return this.importRadarrService.testConnection(dto.url, dto.apiKey);
  }

  @Post('radarr/preview')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  previewRadarr(@Body() dto: PreviewImportDto) {
    return this.importRadarrService.previewRootFolders(dto.url, dto.apiKey);
  }

  @Post('radarr')
  @CheckPolicies((ability) => ability.can(Action.Create, 'Settings'))
  importRadarrApi(@Body() dto: ImportApiDto): Promise<ApiImportResult> {
    return this.importRadarrService.importFromApi(
      dto.url,
      dto.apiKey,
      dto.mode ?? 'skip',
      dto.importSubtitles ?? false,
      dto.pathMappings,
      dto.targetLibraryId,
    );
  }

  // ---------------------------------------------------------------------------
  // Sonarr
  // ---------------------------------------------------------------------------

  @Post('sonarr/test')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  testSonarrConnection(@Body() dto: TestConnectionDto) {
    return this.importSonarrService.testConnection(dto.url, dto.apiKey);
  }

  @Post('sonarr/preview')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  previewSonarr(@Body() dto: PreviewImportDto) {
    return this.importSonarrService.previewRootFolders(dto.url, dto.apiKey);
  }

  @Post('sonarr')
  @CheckPolicies((ability) => ability.can(Action.Create, 'Settings'))
  importSonarrApi(@Body() dto: ImportApiDto): Promise<ApiImportResult> {
    return this.importSonarrService.importFromApi(
      dto.url,
      dto.apiKey,
      dto.mode ?? 'skip',
      dto.importSubtitles ?? false,
      dto.pathMappings,
      dto.targetLibraryId,
    );
  }

  // ---------------------------------------------------------------------------
  // Seerr (Jellyseerr / Overseerr)
  // ---------------------------------------------------------------------------

  @Post('seerr/test')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  testSeerr(@Body() dto: TestConnectionDto) {
    return this.seerr.testConnection(dto.url, dto.apiKey);
  }

  /**
   * Fire-and-forget — returns immediately and pushes progress / final stats
   * via SSE (`seerr.import.{started,completed,failed}`). Long imports
   * (hundreds of requests) would otherwise hold the HTTP socket open for
   * minutes and time out on the client.
   */
  @Post('seerr/import-requests')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  importSeerrRequests() {
    this.events.emit({ type: 'seerr.import.started' });
    void this.seerrImporter.importFromSeerr().then(
      (stats) => {
        this.events.emit({
          type: 'seerr.import.completed',
          users: stats.users,
          usersCreated: stats.usersCreated,
          imported: stats.imported,
          updated: stats.updated,
          skipped: stats.skipped,
        });
      },
      (err) => {
        const message = (err as Error).message;
        this.log.error(
          `Seerr import failed — ${message}`,
          err instanceof Error ? err.stack : err,
        );
        this.events.emit({
          type: 'seerr.import.failed',
          error: message,
        });
      },
    );
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Disk import
  // ---------------------------------------------------------------------------

  @Post('disk/scan')
  @CheckPolicies((ability) => ability.can(Action.Create, Media))
  diskScan(@Body() dto: ScanFolderDto) {
    return this.diskImport.scanFolder(dto.folderPath);
  }

  @Post('disk/confirm')
  @CheckPolicies((ability) => ability.can(Action.Create, Media))
  diskConfirm(@Body() dto: ConfirmDiskImportDto) {
    return this.diskImport.confirmImport(dto.imports);
  }
}
