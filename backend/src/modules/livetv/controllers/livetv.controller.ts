import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import { JwtOrApiKeyGuard } from '../../auth/guards/jwt-or-api-key.guard';
import { SessionTokenGuard } from '../../auth/guards/session-token.guard';
import { PoliciesGuard } from '../../auth/casl/policies.guard';
import { CheckPolicies } from '../../auth/casl/check-policies.decorator';
import { Action } from '../../auth/casl/actions.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthService } from '../../auth/auth.service';
import { User } from '../../users/entities/user.entity';
import { ImageService, ImageSize } from '../../images/image.service';
import { QoeService } from '../../qoe/qoe.service';
import { parseSample } from '../../qoe/core/validate';
import { LiveTvChannel } from '../entities/livetv-channel.entity';
import { LiveTvChannelsService } from '../services/livetv-channels.service';
import { LiveTvGuideService } from '../services/livetv-guide.service';
import { LiveTvSessionService } from '../services/livetv-session.service';
import { LiveTvChannelsQueryDto } from '../dto/livetv-channels-query.dto';
import { LiveTvGuideQueryDto } from '../dto/livetv-guide-query.dto';
import {
  LiveTvOnNowQueryDto,
  LiveTvSearchQueryDto,
} from '../dto/livetv-lookup-query.dto';
import { PlayChannelDto } from '../dto/play-channel.dto';
import { SetChannelPrefsDto } from '../dto/set-channel-prefs.dto';

@Controller('livetv')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class LivetvController {
  constructor(
    private readonly channels: LiveTvChannelsService,
    private readonly guide: LiveTvGuideService,
    private readonly sessions: LiveTvSessionService,
    private readonly auth: AuthService,
    private readonly images: ImageService,
    private readonly qoe: QoeService,
  ) {}

  /** "Configured" means this user's lineup is not empty, not just that they can read it. */
  @Get('status')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  async status(@CurrentUser() user: User): Promise<{ available: boolean }> {
    return { available: (await this.channels.countForUser(user)) > 0 };
  }

  @Get('channels')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  listChannels(
    @Query() query: LiveTvChannelsQueryDto,
    @CurrentUser() user: User,
  ) {
    return this.channels.listForUser(user, query);
  }

  /** A restricted group's channel logo needs the same per-user check as the
   *  channel itself — plain unauthenticated hotlinking (`/api/images/...`)
   *  would otherwise expose it regardless of who is asking. `private` because
   *  the response depends on the caller's own grants, not just the id. */
  @Get('channels/:id/logo')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  async serveLogo(
    @Param('id', ParseIntPipe) id: number,
    @Query('size') size: string | undefined,
    @CurrentUser() user: User,
    @Res() res: Response,
  ): Promise<void> {
    await this.channels.assertVisible(id, user);
    const validSizes: ImageSize[] = ['thumb', 'medium', 'full'];
    const sz: ImageSize = (validSizes as string[]).includes(size ?? '')
      ? (size as ImageSize)
      : 'full';

    let filePath = this.images.getDiskPath('livetv', id, undefined, sz);
    let servedSize = sz;
    if (!fs.existsSync(filePath) && sz !== 'full') {
      filePath = this.images.getDiskPath('livetv', id, undefined, 'full');
      servedSize = 'full';
    }
    if (!fs.existsSync(filePath)) throw new NotFoundException();

    res.set('Cache-Control', 'private, max-age=86400');
    if (servedSize !== sz) res.set('X-Image-Size-Served', servedSize);
    res.sendFile(filePath);
  }

  @Get('channels/on-now')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  onNow(@Query() query: LiveTvOnNowQueryDto, @CurrentUser() user: User) {
    return this.guide.onNow(
      user,
      { group: query.group, query: query.query },
      query.page,
      query.pageSize,
    );
  }

  @Get('guide')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  guideWindow(@Query() query: LiveTvGuideQueryDto, @CurrentUser() user: User) {
    return this.guide.guide({
      from: new Date(query.from),
      to: new Date(query.to),
      group: query.group,
      favoritesOnly: query.favoritesOnly,
      page: query.page,
      pageSize: query.pageSize,
      user,
    });
  }

  @Get('programs/:id')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  program(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.guide.program(id, user);
  }

  @Get('search')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  search(@Query() query: LiveTvSearchQueryDto, @CurrentUser() user: User) {
    return this.guide.search(user, query.q ?? '');
  }

  @Post('channels/:id/play')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  @UseGuards(SessionTokenGuard)
  async play(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PlayChannelDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    const channel = await this.channels.findPlayable(id, user);
    const result = await this.sessions.open(channel, user, {
      ...dto,
      userAgent: req.headers['user-agent'] ?? null,
    });
    const token = this.auth.generateStreamToken(user);
    return {
      ...result,
      url: `${result.url}?token=${encodeURIComponent(token)}`,
    };
  }

  @Delete('sessions/:sessionId')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  @UseGuards(SessionTokenGuard)
  async leave(@Param('sessionId') sessionId: string) {
    await this.sessions.leave(sessionId);
    return { ok: true };
  }

  /** Live player heartbeat carrying its optional QoE sample. */
  @Put('sessions/:sessionId/state')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  @UseGuards(SessionTokenGuard)
  heartbeat(
    @Param('sessionId') sessionId: string,
    @Body() body: { qoe?: unknown; state?: unknown },
    @CurrentUser() user: User,
  ) {
    const ref = this.sessions.qoeRef(sessionId);
    if (!ref) throw new NotFoundException('Live TV session not found');
    if (ref.userId !== user.id)
      throw new ForbiddenException('Not your session');
    const sample = body?.qoe != null ? parseSample(body.qoe) : null;
    if (sample) {
      const state = body.state === 'paused' ? 'paused' : 'playing';
      this.qoe.recordSample({ ...ref, state }, sample);
    }
    return { ok: true };
  }

  @Put('channels/:id/prefs')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  @UseGuards(SessionTokenGuard)
  setPrefs(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetChannelPrefsDto,
    @CurrentUser() user: User,
  ) {
    return this.channels.setPrefs(user, id, dto);
  }
}
