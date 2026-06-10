import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { RequestsService } from './requests.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { UpdateRequestDto } from './dto/update-request.dto';
import { ListRequestsDto } from './dto/list-requests.dto';
import { DeclineRequestDto } from './dto/decline-request.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { FliksRequest } from './entities/request.entity';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { MediaType } from '../../common/enums';

@Controller('requests')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class RequestsController {
  constructor(private readonly requestsService: RequestsService) {}

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Create, FliksRequest))
  create(@CurrentUser() user: User, @Body() dto: CreateRequestDto) {
    return this.requestsService.create(user, dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, FliksRequest))
  findAll(@CurrentUser() user: User, @Query() query: ListRequestsDto) {
    return this.requestsService.findAll(user, query);
  }

  // Declared before `:id` so the literal path isn't captured by ParseIntPipe.
  @Get('title-state')
  @CheckPolicies((ability) => ability.can(Action.Create, FliksRequest))
  titleState(
    @Query('tmdbId', ParseIntPipe) tmdbId: number,
    @Query('mediaType') mediaType: MediaType,
  ) {
    return this.requestsService.getTitleState(tmdbId, mediaType);
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, FliksRequest))
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.requestsService.findOne(id, user);
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Update, FliksRequest))
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRequestDto,
    @CurrentUser() user: User,
  ) {
    return this.requestsService.update(id, dto, user);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Delete, FliksRequest))
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.requestsService.remove(id, user);
  }

  @Post(':id/approve')
  @CheckPolicies((ability) => ability.can(Action.Approve, FliksRequest))
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.requestsService.approve(id, user);
  }

  @Post(':id/decline')
  @CheckPolicies((ability) => ability.can(Action.Decline, FliksRequest))
  decline(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Body() dto: DeclineRequestDto,
  ) {
    return this.requestsService.decline(id, user, dto.reason);
  }

  // Comments
  @Post(':id/comments')
  @CheckPolicies((ability) => ability.can(Action.Read, FliksRequest))
  addComment(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Body() dto: CreateCommentDto,
  ) {
    return this.requestsService.addComment(id, user, dto);
  }

  @Get(':id/comments')
  @CheckPolicies((ability) => ability.can(Action.Read, FliksRequest))
  getComments(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    return this.requestsService.getComments(id, user);
  }

  @Delete('comments/:commentId')
  @CheckPolicies((ability) => ability.can(Action.Read, FliksRequest))
  removeComment(
    @Param('commentId', ParseIntPipe) commentId: number,
    @CurrentUser() user: User,
  ) {
    return this.requestsService.removeComment(commentId, user);
  }
}
