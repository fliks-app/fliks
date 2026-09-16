import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { storeUploadedPlaylist } from '../services/livetv-playlist-file';
import { JwtOrApiKeyGuard } from '../../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../../auth/casl/policies.guard';
import { CheckPolicies } from '../../auth/casl/check-policies.decorator';
import { Action } from '../../auth/casl/actions.enum';
import { LiveTvSourcesService } from '../services/livetv-sources.service';
import { LiveTvChannelsService } from '../services/livetv-channels.service';
import { LiveTvGuideService } from '../services/livetv-guide.service';
import { CreateLiveTvSourceDto } from '../dto/create-livetv-source.dto';
import { UpdateLiveTvSourceDto } from '../dto/update-livetv-source.dto';
import { TestLiveTvSourceDto } from '../dto/test-livetv-source.dto';
import { LiveTvAdminChannelsQueryDto } from '../dto/livetv-admin-channels-query.dto';
import { BulkUpdateChannelsDto } from '../dto/bulk-update-channels.dto';
import { MergeChannelsDto } from '../dto/merge-channels.dto';
import { UpdateLiveTvChannelDto } from '../dto/update-livetv-channel.dto';
import { CreateLiveTvGuideSourceDto } from '../dto/create-livetv-guide-source.dto';
import { UpdateLiveTvGuideSourceDto } from '../dto/update-livetv-guide-source.dto';

/** A real subscription playlist runs to tens of megabytes of text. */
const MAX_PLAYLIST_BYTES = 128 * 1024 * 1024;

@Controller('livetv/admin')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
@CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
export class LivetvAdminController {
  constructor(
    private readonly sources: LiveTvSourcesService,
    private readonly channels: LiveTvChannelsService,
    private readonly guide: LiveTvGuideService,
  ) {}

  // ---------------------------------------------------------------------------
  // Sources
  // ---------------------------------------------------------------------------

  @Get('sources')
  listSources() {
    return this.sources.findAll();
  }

  @Post('sources/test')
  testSource(@Body() dto: TestLiveTvSourceDto) {
    return this.sources.test(dto);
  }

  @Post('sources')
  createSource(@Body() dto: CreateLiveTvSourceDto) {
    return this.sources.create(dto);
  }

  /**
   * Stores a playlist a provider sent by mail and answers the path to use as a
   * source location. Kept separate from source creation so the admin can test
   * the file before committing to it, exactly as they can with a URL.
   */
  @Post('sources/playlist')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_PLAYLIST_BYTES, files: 1, fields: 0, parts: 2 },
    }),
  )
  async uploadPlaylist(@UploadedFile() file: Express.Multer.File) {
    if (!file?.buffer?.length) throw new BadRequestException('No playlist uploaded');
    const head = file.buffer.subarray(0, 64).toString('utf8').trimStart();
    if (!head.startsWith('#EXTM3U') && !head.startsWith('#EXTINF')) {
      throw new BadRequestException('That file is not an extended M3U playlist');
    }
    const location = await storeUploadedPlaylist(file.buffer, file.originalname ?? 'playlist');
    return { location };
  }

  @Patch('sources/:id')
  updateSource(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateLiveTvSourceDto) {
    return this.sources.update(id, dto);
  }

  @Delete('sources/:id')
  removeSource(@Param('id', ParseIntPipe) id: number) {
    return this.sources.remove(id);
  }

  @Post('sources/:id/sync')
  syncSource(@Param('id', ParseIntPipe) id: number) {
    return this.sources.sync(id);
  }

  // ---------------------------------------------------------------------------
  // Channels
  // ---------------------------------------------------------------------------

  @Get('channels')
  listChannels(@Query() query: LiveTvAdminChannelsQueryDto) {
    return this.channels.listForAdmin(query);
  }

  @Patch('channels/bulk')
  bulkUpdateChannels(@Body() dto: BulkUpdateChannelsDto) {
    return this.channels.bulkUpdate(dto);
  }

  @Post('channels/merge')
  mergeChannels(@Body() dto: MergeChannelsDto) {
    return this.channels.merge(dto.targetChannelId, dto.sourceChannelIds);
  }

  @Patch('channels/:id')
  updateChannel(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateLiveTvChannelDto) {
    return this.channels.updateOne(id, dto);
  }

  // ---------------------------------------------------------------------------
  // Guide sources
  // ---------------------------------------------------------------------------

  @Get('guide-sources')
  listGuideSources() {
    return this.guide.findAll();
  }

  @Post('guide-sources')
  createGuideSource(@Body() dto: CreateLiveTvGuideSourceDto) {
    return this.guide.create(dto);
  }

  @Patch('guide-sources/:id')
  updateGuideSource(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateLiveTvGuideSourceDto,
  ) {
    return this.guide.update(id, dto);
  }

  @Delete('guide-sources/:id')
  removeGuideSource(@Param('id', ParseIntPipe) id: number) {
    return this.guide.remove(id);
  }

  @Post('guide-sources/:id/sync')
  syncGuideSource(@Param('id', ParseIntPipe) id: number) {
    return this.guide.syncGuideSource(id);
  }

  @Get('guide/match-report')
  matchReport(@Query('guideSourceId') guideSourceId?: string) {
    return this.guide.matchReport(guideSourceId != null ? Number(guideSourceId) : undefined);
  }
}
