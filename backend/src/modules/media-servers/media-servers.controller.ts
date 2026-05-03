import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseIntPipe,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MediaServersService } from './media-servers.service';
import { CreateMediaServerDto } from './dto/create-media-server.dto';
import { EmbyWatchHistoryImportService } from './emby-watch-history-import.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { EventsService } from '../scheduler/events.service';
import { MediaServerType } from '../../common/enums';

@Controller('media-servers')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class MediaServersController {
  private readonly log = new Logger(MediaServersController.name);

  constructor(
    private readonly service: MediaServersService,
    private readonly embyHistoryImport: EmbyWatchHistoryImportService,
    private readonly events: EventsService,
  ) {}

  @Get('types')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  getTypes() {
    return this.service.getTypes();
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  create(@Body() dto: CreateMediaServerDto) {
    return this.service.create(dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateMediaServerDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }

  @Post(':id/test')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  test(@Param('id', ParseIntPipe) id: number) {
    return this.service.testConnection(id);
  }

  @Post(':id/import-watch-history')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async importWatchHistory(@Param('id', ParseIntPipe) id: number) {
    const server = await this.service.findOne(id);
    if (!server) throw new NotFoundException(`MediaServer #${id} not found`);
    if (server.type !== MediaServerType.EMBY) {
      throw new NotFoundException(
        `Watch-history import is only supported for Emby servers`,
      );
    }

    const serverId = server.id;
    const serverName = server.name;
    this.events.emit({
      type: 'watch-history.import.started',
      serverId,
      serverName,
    });

    // Fire-and-forget — SSE delivers the final result.
    void this.embyHistoryImport.importForServer(server).then(
      (stats) => {
        this.events.emit({
          type: 'watch-history.import.completed',
          serverId,
          serverName,
          users: stats.users,
          usersCreated: stats.usersCreated,
          imported: stats.imported,
          skipped: stats.skipped,
        });
      },
      (err) => {
        const message = (err as Error).message;
        this.log.error(
          `Watch-history import failed — server=${serverId} "${serverName}" error=${message}`,
          err instanceof Error ? err.stack : err,
        );
        this.events.emit({
          type: 'watch-history.import.failed',
          serverId,
          serverName,
          error: message,
        });
      },
    );
    return { ok: true };
  }
}
