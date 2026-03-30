import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CreateNotificationConnectionDto } from './dto/create-notification-connection.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';

@Controller('notifications')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  create(@Body() dto: CreateNotificationConnectionDto) {
    return this.service.create(dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateNotificationConnectionDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }

  @Post(':id/test')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  test(@Param('id', ParseIntPipe) id: number) {
    return this.service.testConnection(id);
  }
}
