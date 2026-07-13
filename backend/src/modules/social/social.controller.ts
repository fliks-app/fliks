import {
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
}
