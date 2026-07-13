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
import { LikesService } from './likes.service';
import { LikeTargetDto } from './dto/like-target.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

/** Personal "likes" on movies / seasons / episodes. JWT-guarded; all scoping
 *  lives in the service (library ACL). */
@Controller('likes')
@UseGuards(JwtOrApiKeyGuard)
export class LikesController {
  constructor(private readonly service: LikesService) {}

  @Get()
  mine(@CurrentUser() me: User, @Query('libraryId') libraryId?: string) {
    return this.service.myLikes(me, libraryId ? +libraryId : undefined);
  }

  @Get('state/:mediaId')
  state(@CurrentUser() me: User, @Param('mediaId', ParseIntPipe) mediaId: number) {
    return this.service.stateFor(me, mediaId);
  }

  @Post()
  like(@CurrentUser() me: User, @Body() dto: LikeTargetDto) {
    return this.service.like(me, dto);
  }

  @Delete()
  unlike(@CurrentUser() me: User, @Body() dto: LikeTargetDto) {
    return this.service.unlike(me, dto);
  }
}
