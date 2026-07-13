import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SocialService } from './social.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { RecommendContentDto } from './dto/recommend-content.dto';

/**
 * Social graph + public profiles. Guarded by JWT only — every visibility /
 * privacy rule lives in {@link SocialService} (same pattern as PlaybackController),
 * so no CASL subject is needed.
 */
@Controller('social')
@UseGuards(JwtOrApiKeyGuard)
export class SocialController {
  constructor(private readonly service: SocialService) {}

  @Get('search')
  search(@CurrentUser() me: User, @Query('q') q: string) {
    return this.service.search(me, q ?? '');
  }

  @Get('connectable')
  connectable(@CurrentUser() me: User, @Query('q') q: string) {
    return this.service.searchConnectable(me, q ?? '');
  }

  @Get('recommendations')
  followingRecommendations(
    @CurrentUser() me: User,
    @Query('libraryId') libraryId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.followingRecommendations(
      me,
      libraryId ? +libraryId : undefined,
      limit ? Math.min(+limit, 50) : 20,
    );
  }

  /** Recommend a movie / season / episode to another member. */
  @Post('recommend')
  recommend(@CurrentUser() me: User, @Body() dto: RecommendContentDto) {
    return this.service.recommend(me, dto);
  }

  /** Content other members have recommended to me. Active feed by default;
   *  `?includeDismissed=true` returns the full history (profile page). */
  @Get('recommendations/received')
  receivedRecommendations(
    @CurrentUser() me: User,
    @Query('includeDismissed') includeDismissed?: string,
  ) {
    return this.service.receivedRecommendations(me, includeDismissed === 'true');
  }

  /** Content I have recommended to other members. */
  @Get('recommendations/sent')
  sentRecommendations(@CurrentUser() me: User) {
    return this.service.sentRecommendations(me);
  }

  @Post('recommendations/:id/dismiss')
  dismissRecommendation(
    @CurrentUser() me: User,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.dismissRecommendation(me, id);
  }

  @Get('requests')
  requests(@CurrentUser() me: User) {
    return this.service.listRequests(me);
  }

  @Post('follow/:userId')
  follow(@CurrentUser() me: User, @Param('userId', ParseIntPipe) userId: number) {
    return this.service.follow(me, userId);
  }

  @Delete('follow/:userId')
  unfollow(@CurrentUser() me: User, @Param('userId', ParseIntPipe) userId: number) {
    return this.service.unfollow(me, userId);
  }

  @Post('requests/:userId/accept')
  accept(@CurrentUser() me: User, @Param('userId', ParseIntPipe) userId: number) {
    return this.service.acceptRequest(me, userId);
  }

  @Post('requests/:userId/reject')
  reject(@CurrentUser() me: User, @Param('userId', ParseIntPipe) userId: number) {
    return this.service.rejectRequest(me, userId);
  }

  @Get('users/:userId/followers')
  followers(@CurrentUser() me: User, @Param('userId', ParseIntPipe) userId: number) {
    return this.service.listFollowers(me, userId);
  }

  @Get('users/:userId/following')
  following(@CurrentUser() me: User, @Param('userId', ParseIntPipe) userId: number) {
    return this.service.listFollowing(me, userId);
  }

  @Get('users/:userId/profile')
  profile(@CurrentUser() me: User, @Param('userId', ParseIntPipe) userId: number) {
    return this.service.getProfile(me, userId);
  }

  @Get('users/:userId/stats')
  stats(@CurrentUser() me: User, @Param('userId', ParseIntPipe) userId: number) {
    return this.service.getUserStats(me, userId);
  }
}
