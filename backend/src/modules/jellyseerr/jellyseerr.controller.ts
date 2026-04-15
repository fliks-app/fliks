import {
  Body,
  Controller,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { EventsService } from '../scheduler/events.service';
import { JellyseerrService } from './jellyseerr.service';
import { JellyseerrRequestImportService } from './jellyseerr-request-import.service';

class TestConnectionDto {
  @IsString()
  @IsNotEmpty()
  url: string;

  @IsString()
  @IsNotEmpty()
  apiKey: string;
}

@Controller('jellyseerr')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class JellyseerrController {
  private readonly log = new Logger(JellyseerrController.name);

  constructor(
    private readonly jellyseerr: JellyseerrService,
    private readonly importer: JellyseerrRequestImportService,
    private readonly events: EventsService,
  ) {}

  @Post('test')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  test(@Body() dto: TestConnectionDto) {
    return this.jellyseerr.testConnection(dto.url, dto.apiKey);
  }

  /**
   * Fire-and-forget — returns immediately and pushes progress / final stats
   * via SSE (`jellyseerr.import.{started,completed,failed}`). Long imports
   * (hundreds of requests) would otherwise hold the HTTP socket open for
   * minutes and time out on the client.
   */
  @Post('import-requests')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  importRequests() {
    this.events.emit({ type: 'jellyseerr.import.started' });
    void this.importer.importFromJellyseerr().then(
      (stats) => {
        this.events.emit({
          type: 'jellyseerr.import.completed',
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
          `Jellyseerr import failed — ${message}`,
          err instanceof Error ? err.stack : err,
        );
        this.events.emit({
          type: 'jellyseerr.import.failed',
          error: message,
        });
      },
    );
    return { ok: true };
  }
}
