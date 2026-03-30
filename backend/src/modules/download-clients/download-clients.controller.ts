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
import { DownloadClientsService } from './download-clients.service';
import { CreateDownloadClientDto } from './dto/create-download-client.dto';
import { UpdateDownloadClientDto } from './dto/update-download-client.dto';
import { TestDownloadClientDto } from './dto/test-download-client.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { DownloadClient } from './entities/download-client.entity';

@Controller('download-clients')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class DownloadClientsController {
  constructor(private readonly service: DownloadClientsService) {}

  @Post('test-connection')
  @CheckPolicies((ability) => ability.can(Action.Create, DownloadClient))
  testConnection(@Body() dto: TestDownloadClientDto) {
    return this.service.testConnection(dto);
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Create, DownloadClient))
  create(@Body() dto: CreateDownloadClientDto) {
    return this.service.create(dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, DownloadClient))
  findAll() {
    return this.service.findAll();
  }

  /** Returns active torrents from all enabled qBittorrent clients */
  @Get('queue')
  @CheckPolicies((ability) => ability.can(Action.Read, DownloadClient))
  queue() {
    return this.service.getQueue();
  }

  @Delete('queue/:hash')
  @CheckPolicies((ability) => ability.can(Action.Delete, DownloadClient))
  removeTorrent(
    @Param('hash') hash: string,
    @Query('clientId', ParseIntPipe) clientId: number,
    @Query('deleteFiles') deleteFiles?: string,
  ) {
    return this.service.removeTorrent(
      clientId,
      hash,
      deleteFiles === 'true',
    );
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, DownloadClient))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Update, DownloadClient))
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateDownloadClientDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Delete, DownloadClient))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
