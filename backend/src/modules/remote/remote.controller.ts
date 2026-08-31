import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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
import { ClaimGrantDto, CreateGrantCodeDto } from './dto/remote-grant.dto';
import { GrantDto, RemoteGrantService } from './remote-grant.service';

@Controller('remote')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard, SessionTokenGuard)
export class RemoteController {
  constructor(
    private readonly remote: RemoteService,
    private readonly grants: RemoteGrantService,
  ) {}

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

  /** Offer this device for control: the code goes on its own screen. */
  @Post('grants/code')
  @CheckPolicies(() => true)
  createGrantCode(
    @CurrentUser() user: User,
    @Body() body: CreateGrantCodeDto,
  ): Promise<{ id: number; code: string; expiresIn: number }> {
    return this.grants.createCode(user, body.deviceId, body.deviceName);
  }

  /** Claim a code read off another device's screen. */
  @Post('grants/claim')
  @CheckPolicies(() => true)
  claimGrant(
    @CurrentUser() user: User,
    @Body() body: ClaimGrantDto,
  ): Promise<GrantDto> {
    return this.grants.claim(user, body.code);
  }

  /** Both revocation lists: what this device handed out, and what this account
   *  may control. `deviceId` scopes the first to the asking device. */
  @Get('grants')
  @CheckPolicies(() => true)
  async listGrants(
    @CurrentUser() user: User,
    @Query('deviceId') deviceId?: string,
  ): Promise<{ issued: GrantDto[]; held: GrantDto[] }> {
    const [issued, held] = await Promise.all([
      this.grants.listForOwner(user.id, deviceId),
      this.grants.listForGrantee(user.id),
    ]);
    return { issued, held };
  }

  /** Either side can end a grant: the device that gave it, or its holder. */
  @Delete('grants/:id')
  @HttpCode(204)
  @CheckPolicies(() => true)
  revokeGrant(
    @CurrentUser() user: User,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.grants.revoke(id, user);
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
