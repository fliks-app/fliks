import {
  Controller,
  Get,
  Put,
  Delete,
  Post,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseIntPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from './users.service';
import { UsersStatsService } from './users-stats.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { User } from './entities/user.entity';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('users')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly usersStatsService: UsersStatsService,
  ) {}

  /** Admin: list all users */
  @Get()
  @CheckPolicies((ability) => ability.can(Action.Manage, User))
  findAll() {
    return this.usersService.findAll();
  }

  /** Admin: create a new user */
  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, User))
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  /** Self: upload a new avatar (cropped square JPEG). No policy handler → the
   *  class JWT guard is enough; the target is always the caller. */
  @Post('me/avatar')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  setAvatar(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: User,
  ) {
    return this.usersService.setAvatar(user.id, file);
  }

  /** Self: remove the current avatar. */
  @Delete('me/avatar')
  clearAvatar(@CurrentUser() user: User) {
    return this.usersService.clearAvatar(user.id);
  }

  /** Admin or self */
  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, User))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.findOne(id);
  }

  /** Admin: aggregated activity stats for the user-detail Statistics tab. */
  @Get(':id/stats')
  @CheckPolicies((ability) => ability.can(Action.Manage, User))
  getStats(@Param('id', ParseIntPipe) id: number) {
    return this.usersStatsService.getUserStats(id);
  }

  /** Admin or self */
  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Update, User))
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @CurrentUser() requester: User,
  ) {
    return this.usersService.update(id, dto, requester);
  }

  /** Admin only */
  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, User))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.remove(id);
  }
}
