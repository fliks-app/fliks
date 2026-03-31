import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { MediaService } from './media.service';
import { MovieDownloadService } from './movie-download.service';
import { EpisodeDownloadService } from './episode-download.service';
import { DiskImportService } from './disk-import.service';
import { CreateMediaDto } from './dto/create-media.dto';
import { UpdateMediaDto } from './dto/update-media.dto';
import { SearchMediaDto } from './dto/search-media.dto';
import { ImportTmdbDto } from './dto/import-tmdb.dto';
import { GrabMovieDto } from './dto/grab-movie.dto';
import { ScanFolderDto } from './dto/scan-folder.dto';
import { ConfirmDiskImportDto } from './dto/confirm-disk-import.dto';
import { UpdateMediaProfilesDto } from './dto/update-media-profiles.dto';
import { BulkUpdateMediaDto } from './dto/bulk-update-media.dto';
import { CalendarQueryDto } from './dto/calendar-query.dto';
import { HistoryQueryDto } from './dto/history-query.dto';
import { PatchMonitoredDto } from './dto/patch-monitored.dto';
import { UpdatePathDto } from './dto/update-path.dto';
import { LinkTorrentDto } from './dto/link-torrent.dto';
import { SUITARR_QUALITIES } from '../../common/constants/suitarr-qualities';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { Media } from './entities/media.entity';

@Controller('media')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class MediaController {
  constructor(
    private readonly mediaService: MediaService,
    private readonly movieDownload: MovieDownloadService,
    private readonly episodeDownload: EpisodeDownloadService,
    private readonly diskImport: DiskImportService,
  ) {}

  @Post('import/tmdb')
  @CheckPolicies((ability) => ability.can(Action.Create, Media))
  importFromTmdb(@Body() dto: ImportTmdbDto) {
    return this.mediaService.importFromTmdb(dto);
  }

  @Post('import/disk/scan')
  @CheckPolicies((ability) => ability.can(Action.Create, Media))
  diskScan(@Body() dto: ScanFolderDto) {
    return this.diskImport.scanFolder(dto.folderPath);
  }

  @Post('import/disk/confirm')
  @CheckPolicies((ability) => ability.can(Action.Create, Media))
  diskConfirm(@Body() dto: ConfirmDiskImportDto) {
    return this.diskImport.confirmImport(dto.imports);
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Create, Media))
  create(@Body() dto: CreateMediaDto) {
    return this.mediaService.create(dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  findAll(@Query() query: SearchMediaDto) {
    return this.mediaService.findAll(query);
  }

  @Get('qualities')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  suitarrQualities() {
    return SUITARR_QUALITIES;
  }

  @Get('calendar')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  calendar(@Query() query: CalendarQueryDto) {
    return this.mediaService.getCalendar(query);
  }

  @Get('history')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  history(@Query() query: HistoryQueryDto) {
    return this.mediaService.getHistory(query);
  }

  @Delete('history/:historyId')
  @CheckPolicies((ability) => ability.can(Action.Delete, Media))
  deleteHistory(@Param('historyId', ParseIntPipe) id: number) {
    return this.mediaService.deleteHistoryEntry(id);
  }

  @Post('history/link')
  @CheckPolicies((ability) => ability.can(Action.Manage, Media))
  linkTorrent(@Body() dto: LinkTorrentDto) {
    return this.mediaService.linkTorrentToMedia(
      dto.mediaId,
      dto.sourceTitle,
      dto.clientId,
    );
  }

  @Post('history/:historyId/retry')
  @CheckPolicies((ability) => ability.can(Action.Manage, Media))
  retryImport(@Param('historyId', ParseIntPipe) id: number) {
    return this.mediaService.retryImport(id);
  }

  @Patch('bulk')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  bulkUpdate(@Body() dto: BulkUpdateMediaDto) {
    return this.mediaService.bulkUpdate(dto);
  }

  @Post(':id/rename')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  renameFiles(@Param('id', ParseIntPipe) id: number) {
    return this.mediaService.renameFiles(id);
  }

  @Get(':id/releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  movieReleases(@Param('id', ParseIntPipe) id: number, @Query('q') customQuery?: string) {
    return this.movieDownload.searchMovieReleases(id, customQuery);
  }

  @Post(':id/grab')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  grabMovie(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: GrabMovieDto,
  ) {
    return this.movieDownload.grabMovie(id, dto ?? {});
  }

  @Get(':id/upgrade-releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  upgradeReleases(@Param('id', ParseIntPipe) id: number, @Query('q') customQuery?: string) {
    return this.movieDownload.searchUpgradeReleases(id, customQuery);
  }

  @Post(':id/upgrade')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  grabUpgrade(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: GrabMovieDto,
  ) {
    return this.movieDownload.grabUpgrade(id, dto ?? {});
  }

  @Get(':id/seasons/:seasonId/releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  seasonReleases(
    @Param('id', ParseIntPipe) id: number,
    @Param('seasonId', ParseIntPipe) seasonId: number,
    @Query('q') customQuery?: string,
  ) {
    return this.episodeDownload.searchSeasonReleases(id, seasonId, customQuery);
  }

  @Post(':id/seasons/:seasonId/grab')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  grabSeason(
    @Param('id', ParseIntPipe) id: number,
    @Param('seasonId', ParseIntPipe) seasonId: number,
    @Body() dto: GrabMovieDto,
  ) {
    return this.episodeDownload.grabSeason(id, seasonId, dto ?? {});
  }

  @Get(':id/episodes/:episodeId/releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  episodeReleases(
    @Param('id', ParseIntPipe) id: number,
    @Param('episodeId', ParseIntPipe) episodeId: number,
    @Query('q') customQuery?: string,
  ) {
    return this.episodeDownload.searchEpisodeReleases(id, episodeId, customQuery);
  }

  @Post(':id/episodes/:episodeId/grab')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  grabEpisode(
    @Param('id', ParseIntPipe) id: number,
    @Param('episodeId', ParseIntPipe) episodeId: number,
    @Body() dto: GrabMovieDto,
  ) {
    return this.episodeDownload.grabEpisode(id, episodeId, dto ?? {});
  }

  @Delete(':id/files/:fileId')
  @CheckPolicies((ability) => ability.can(Action.Delete, Media))
  deleteFile(
    @Param('id', ParseIntPipe) id: number,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Query('deleteOnDisk') deleteOnDisk?: string,
  ) {
    return this.mediaService.deleteMediaFile(id, fileId, deleteOnDisk === 'true');
  }

  @Patch(':id/root-folder')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  updatePath(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePathDto,
  ) {
    return this.mediaService.updatePath(id, dto.path);
  }

  @Patch(':id/profiles')
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Grab, Media) ||
      ability.can(Action.Update, Media),
  )
  updateProfiles(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMediaProfilesDto,
  ) {
    return this.mediaService.updateProfiles(id, dto);
  }

  @Post(':id/refresh')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  refreshMetadata(@Param('id', ParseIntPipe) id: number) {
    return this.mediaService.refreshMetadata(id);
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.mediaService.findOne(id);
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMediaDto,
  ) {
    return this.mediaService.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Delete, Media))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.mediaService.remove(id);
  }

  @Patch('seasons/:seasonId')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  patchSeason(
    @Param('seasonId', ParseIntPipe) seasonId: number,
    @Body() dto: PatchMonitoredDto,
  ) {
    return this.mediaService.updateSeasonMonitored(seasonId, dto.monitored);
  }

  @Patch('episodes/:episodeId')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  patchEpisode(
    @Param('episodeId', ParseIntPipe) episodeId: number,
    @Body() dto: PatchMonitoredDto,
  ) {
    return this.mediaService.updateEpisodeMonitored(episodeId, dto.monitored);
  }
}
