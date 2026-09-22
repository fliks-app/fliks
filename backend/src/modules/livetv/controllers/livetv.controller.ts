import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import * as path from 'path';
import { JwtOrApiKeyGuard } from '../../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../../auth/casl/policies.guard';
import { CheckPolicies } from '../../auth/casl/check-policies.decorator';
import { Action } from '../../auth/casl/actions.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthService } from '../../auth/auth.service';
import { User } from '../../users/entities/user.entity';
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

/** `seg-00000.m4s` / `seg-00000.ts` / `init.mp4`: our own live output naming.
 *  `%05d` is a minimum width, so ffmpeg keeps writing 6+ digit names past segment 99999. */
export const SEGMENT_NAME_RE = /^(init\.mp4|seg-\d{5,}\.(m4s|ts))$/;

function firstQueryString(query: Request['query'], key: string): string | undefined {
  const v = query[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

/**
 * Appends `?token=<token>` to every segment/init reference in a raw live HLS
 * playlist. ffmpeg has no notion of Fliks auth, and a native player rarely
 * carries an Authorization header, so the token travels in the URL instead,
 * exactly like `streaming.controller.ts`'s manifest routes.
 */
function withToken(raw: string, token: string | undefined): string {
  if (!token) return raw;
  const suffix = `?token=${encodeURIComponent(token)}`;
  return raw
    .split('\n')
    .map((line) => {
      if (line.startsWith('#EXT-X-MAP')) {
        return line.replace(/URI="([^"]+)"/, (_m, uri: string) => `URI="${uri}${suffix}"`);
      }
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      return `${trimmed}${suffix}`;
    })
    .join('\n');
}

@Controller('livetv')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class LivetvController {
  constructor(
    private readonly channels: LiveTvChannelsService,
    private readonly guide: LiveTvGuideService,
    private readonly sessions: LiveTvSessionService,
    private readonly auth: AuthService,
  ) {}

  /** Read is open to everyone, so "configured" means this user's lineup is not empty. */
  @Get('status')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  async status(@CurrentUser() user: User): Promise<{ available: boolean }> {
    return { available: (await this.channels.countForUser(user)) > 0 };
  }

  @Get('channels')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  listChannels(@Query() query: LiveTvChannelsQueryDto, @CurrentUser() user: User) {
    return this.channels.listForUser(user, query);
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
    return { ...result, url: `${result.url}?token=${encodeURIComponent(token)}` };
  }

  @Delete('sessions/:sessionId')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  async leave(@Param('sessionId') sessionId: string) {
    await this.sessions.leave(sessionId);
    return { ok: true };
  }

  @Get('sessions/:sessionId/index.m3u8')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  async servePlaylist(
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const session = this.sessions.getForServe(sessionId);
    if (!session) throw new NotFoundException('Live TV session not found');

    const playlistPath = path.join(session.dir, 'index.m3u8');
    if (!fs.existsSync(playlistPath)) throw new NotFoundException('Playlist not ready yet');
    const raw = fs.readFileSync(playlistPath, 'utf-8');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    res.send(withToken(raw, firstQueryString(req.query, 'token')));
  }

  /** Direct play: one shared upstream per session, teed to every viewer so a
   *  household watching together costs the provider a single connection. Its
   *  own URL, because a player picking a demuxer from the extension must not
   *  be handed `.m3u8` for a raw stream. */
  @Get('sessions/:sessionId/direct.ts')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  serveDirect(@Param('sessionId') sessionId: string, @Res() res: Response): void {
    const session = this.sessions.getForServe(sessionId);
    if (!session || session.mode !== 'direct') {
      throw new NotFoundException('Live TV session not found');
    }
    const tee = this.sessions.attachDirectViewer(session, sessionId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', session.directContentType ?? 'video/mp2t');
    res.on('close', () => this.sessions.detachDirectViewer(session, tee));
    tee.pipe(res);
  }

  @Get('sessions/:sessionId/:segment')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  serveSegment(
    @Param('sessionId') sessionId: string,
    @Param('segment') segment: string,
    @Res() res: Response,
  ): void {
    const session = this.sessions.getForServe(sessionId);
    if (!session || session.mode === 'direct') {
      throw new NotFoundException('Live TV segment not found');
    }
    if (!SEGMENT_NAME_RE.test(segment)) {
      throw new BadRequestException(`Invalid segment name: ${segment}`);
    }
    const filePath = path.join(session.dir, segment);
    if (!fs.existsSync(filePath)) throw new NotFoundException('Live TV segment not found');
    res.setHeader('Content-Type', segment.endsWith('.ts') ? 'video/mp2t' : 'video/mp4');
    res.sendFile(filePath);
  }

  @Put('channels/:id/prefs')
  @CheckPolicies((ability) => ability.can(Action.Read, LiveTvChannel))
  setPrefs(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetChannelPrefsDto,
    @CurrentUser() user: User,
  ) {
    return this.channels.setPrefs(user, id, dto);
  }
}
