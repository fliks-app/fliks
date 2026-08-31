import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { SessionTokenGuard } from '../auth/guards/session-token.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { RemoteService } from './remote.service';
import { RemoteCommandDto } from './dto/remote-command.dto';
import { RemoteTargetDto } from './dto/remote-target.dto';
import { RemoteRegisterDto } from './dto/remote-register.dto';

@Controller('remote')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard, SessionTokenGuard)
export class RemoteController {
  constructor(private readonly remote: RemoteService) {}

  // Every route here acts on the caller's own scope (self + household), which
  // CASL has no object to test: the real gate is `RemoteService.canControl`.
  @Get('targets')
  @CheckPolicies(() => true)
  listTargets(
    @CurrentUser() user: User,
    @Query('self') self?: string,
  ): Promise<RemoteTargetDto[]> {
    return this.remote.listTargets(user, self ?? null);
  }

  // A client with no SSE primitive announces itself here and polls for its
  // commands; every other route treats it as an ordinary target.
  @Post('register')
  @CheckPolicies(() => true)
  register(
    @CurrentUser() user: User,
    @Body() body: RemoteRegisterDto,
  ): { targetId: string } {
    return this.remote.registerPolledTarget(user, body);
  }

  @Get('commands')
  @CheckPolicies(() => true)
  drainCommands(
    @CurrentUser() user: User,
    @Query('targetId') targetId: string,
  ): Promise<unknown[]> {
    return this.remote.drainCommands(user, targetId);
  }

  @Post(':targetId/command')
  @HttpCode(202)
  @CheckPolicies(() => true)
  sendCommand(
    @CurrentUser() user: User,
    @Param('targetId') targetId: string,
    @Body() dto: RemoteCommandDto,
  ): Promise<{ cmdId: string }> {
    return this.remote.sendCommand(user, targetId, dto);
  }
}
