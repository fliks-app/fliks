import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { CurrentUser } from '../../modules/auth/decorators/current-user.decorator';
import { JwtOrApiKeyGuard } from '../../modules/auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../../modules/auth/casl/policies.guard';
import { CheckPolicies } from '../../modules/auth/casl/check-policies.decorator';
import { Action } from '../../modules/auth/casl/actions.enum';
import { Media } from '../../modules/media/entities/media.entity';
import { MediaService } from '../../modules/media/media.service';
import { LibrariesService } from '../../modules/libraries/libraries.service';
import { MovieDownloadService } from './movie-download.service';
import { EpisodeDownloadService } from './episode-download.service';
import { GrabMovieDto } from './dto/grab-movie.dto';
import type { User } from '../../modules/users/entities/user.entity';

@Controller('media')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class GrabController {
  constructor(
    private readonly mediaService: MediaService,
    private readonly libraries: LibrariesService,
    private readonly movieDownload: MovieDownloadService,
    private readonly episodeDownload: EpisodeDownloadService,
  ) {}

  /**
   * Throws NotFound when the user can't access the media's library.
   * Use at the start of every per-media endpoint to seal off cross-library leaks.
   */
  private async assertMediaAccessible(id: number, user: User): Promise<void> {
    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    await this.mediaService.assertAccessible(id, accessible);
  }

  @Get(':id/releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async movieReleases(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Query('q') customQuery?: string,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.movieDownload.searchMovieReleases(id, customQuery);
  }

  @Post(':id/grab')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  async grabMovie(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Body() dto: GrabMovieDto,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.movieDownload.grabMovie(id, dto ?? {});
  }

  @Get(':id/upgrade-releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async upgradeReleases(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Query('q') customQuery?: string,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.movieDownload.searchUpgradeReleases(id, customQuery);
  }

  @Post(':id/upgrade')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  async grabUpgrade(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Body() dto: GrabMovieDto,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.movieDownload.grabUpgrade(id, dto ?? {});
  }

  @Get(':id/seasons/:seasonId/releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async seasonReleases(
    @Param('id', ParseIntPipe) id: number,
    @Param('seasonId', ParseIntPipe) seasonId: number,
    @CurrentUser() user: User,
    @Query('q') customQuery?: string,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.episodeDownload.searchSeasonReleases(id, seasonId, customQuery);
  }

  @Post(':id/seasons/:seasonId/grab')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  async grabSeason(
    @Param('id', ParseIntPipe) id: number,
    @Param('seasonId', ParseIntPipe) seasonId: number,
    @CurrentUser() user: User,
    @Body() dto: GrabMovieDto,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.episodeDownload.grabSeason(id, seasonId, dto ?? {});
  }

  @Get(':id/episodes/:episodeId/releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async episodeReleases(
    @Param('id', ParseIntPipe) id: number,
    @Param('episodeId', ParseIntPipe) episodeId: number,
    @CurrentUser() user: User,
    @Query('q') customQuery?: string,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.episodeDownload.searchEpisodeReleases(
      id,
      episodeId,
      customQuery,
    );
  }

  @Post(':id/episodes/:episodeId/grab')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  async grabEpisode(
    @Param('id', ParseIntPipe) id: number,
    @Param('episodeId', ParseIntPipe) episodeId: number,
    @CurrentUser() user: User,
    @Body() dto: GrabMovieDto,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.episodeDownload.grabEpisode(id, episodeId, dto ?? {});
  }
}
