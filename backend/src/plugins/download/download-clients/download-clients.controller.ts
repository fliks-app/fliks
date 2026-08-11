import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { DownloadClientsService, redactPassword } from './download-clients.service';
import { CreateDownloadClientDto } from './dto/create-download-client.dto';
import { UpdateDownloadClientDto } from './dto/update-download-client.dto';
import { TestDownloadClientDto } from './dto/test-download-client.dto';
import { JwtOrApiKeyGuard } from '../../../modules/auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../../../modules/auth/casl/policies.guard';
import { CheckPolicies } from '../../../modules/auth/casl/check-policies.decorator';
import { Action } from '../../../modules/auth/casl/actions.enum';
import { Media } from '../../../modules/media/entities/media.entity';

@Controller('download-clients')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class DownloadClientsController {
  constructor(private readonly service: DownloadClientsService) {}

  @Post('test-connection')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  testConnection(@Body() dto: TestDownloadClientDto) {
    return this.service.testConnection(dto);
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  create(@Body() dto: CreateDownloadClientDto) {
    return this.service.create(dto);
  }

  @Get()
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Manage, 'Settings') ||
      ability.can(Action.Track, Media),
  )
  findAll() {
    return this.service.findAll();
  }

  /** Returns active torrents from all enabled qBittorrent clients,
   *  filtered by torrent / Fliks status and paginated. */
  @Get('queue')
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Manage, 'Settings') ||
      ability.can(Action.Track, Media),
  )
  queue(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('torrentStatus') torrentStatus?: string,
    @Query('fliksStatus') fliksStatus?: string,
    @Query('search') search?: string,
  ) {
    return this.service.getQueue({
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      torrentStatus: torrentStatus || undefined,
      fliksStatus: fliksStatus || undefined,
      search: search?.trim() || undefined,
    });
  }

  @Post('queue/link')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  linkTorrent(@Body() body: { mediaId: number; torrentHash: string }) {
    return this.service.linkTorrentToMedia(body.mediaId, body.torrentHash);
  }

  @Post('queue/:hash/reimport')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  reimport(@Param('hash') hash: string) {
    return this.service.reimport(hash);
  }

  @Post('queue/:hash/block')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  blockTorrent(
    @Param('hash') hash: string,
    @Query('clientId', ParseIntPipe) clientId: number,
  ) {
    return this.service.blockTorrent(clientId, hash);
  }

  @Delete('queue/:hash')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  removeTorrent(
    @Param('hash') hash: string,
    @Query('clientId', ParseIntPipe) clientId: number,
    @Query('deleteFiles') deleteFiles?: string,
  ) {
    return this.service.removeTorrent(clientId, hash, deleteFiles === 'true');
  }

  @Get(':id')
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Manage, 'Settings') ||
      ability.can(Action.Track, Media),
  )
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return redactPassword(await this.service.findOne(id));
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDownloadClientDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
