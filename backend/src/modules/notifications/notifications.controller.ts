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
import {
  NotificationsService,
  SUBSCRIBABLE_NOTIFICATION_EVENTS,
  redactNotificationSecrets,
} from './notifications.service';
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
  async create(@Body() dto: CreateNotificationConnectionDto) {
    return redactNotificationSecrets(await this.service.create(dto));
  }

  // Redacted here, not in the service: the service's own reads are what
  // authenticate against the provider and need the real credential.
  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async findAll() {
    return (await this.service.findAll()).map(redactNotificationSecrets);
  }

  /** Declared before `:id` — Nest matches in order, and `events` is not an id. */
  @Get('events')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  events(): readonly string[] {
    return SUBSCRIBABLE_NOTIFICATION_EVENTS;
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return redactNotificationSecrets(await this.service.findOne(id));
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateNotificationConnectionDto,
  ) {
    return redactNotificationSecrets(await this.service.update(id, dto));
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
