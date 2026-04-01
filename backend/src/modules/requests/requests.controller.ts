import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { RequestsService } from './requests.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { ListRequestsDto } from './dto/list-requests.dto';
import { DeclineRequestDto } from './dto/decline-request.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { SuitarrRequest } from './entities/request.entity';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@Controller('requests')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class RequestsController {
  constructor(private readonly requestsService: RequestsService) {}

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Create, SuitarrRequest))
  create(@CurrentUser() user: User, @Body() dto: CreateRequestDto) {
    return this.requestsService.create(user, dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, SuitarrRequest))
  findAll(@CurrentUser() user: User, @Query() query: ListRequestsDto) {
    return this.requestsService.findAll(user, query);
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, SuitarrRequest))
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.requestsService.findOne(id, user);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Delete, SuitarrRequest))
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.requestsService.remove(id, user);
  }

  @Post(':id/approve')
  @CheckPolicies((ability) => ability.can(Action.Approve, SuitarrRequest))
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.requestsService.approve(id, user);
  }

  @Post(':id/decline')
  @CheckPolicies((ability) => ability.can(Action.Decline, SuitarrRequest))
  decline(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Body() dto: DeclineRequestDto,
  ) {
    return this.requestsService.decline(id, user, dto.reason);
  }

  // Comments
  @Post(':id/comments')
  @CheckPolicies((ability) => ability.can(Action.Read, SuitarrRequest))
  addComment(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Body() dto: CreateCommentDto,
  ) {
    return this.requestsService.addComment(id, user, dto);
  }

  @Get(':id/comments')
  @CheckPolicies((ability) => ability.can(Action.Read, SuitarrRequest))
  getComments(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    return this.requestsService.getComments(id, user);
  }

  @Delete('comments/:commentId')
  @CheckPolicies((ability) => ability.can(Action.Read, SuitarrRequest))
  removeComment(
    @Param('commentId', ParseIntPipe) commentId: number,
    @CurrentUser() user: User,
  ) {
    return this.requestsService.removeComment(commentId, user);
  }
}
