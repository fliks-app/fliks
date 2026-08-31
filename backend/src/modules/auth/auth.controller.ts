import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Res,
  Req,
  Headers,
  HttpCode,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from './dto/login.dto';
import { JwtOrApiKeyGuard } from './guards/jwt-or-api-key.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { ACCESS_TOKEN_COOKIE } from './auth.constants';
import { resolveStreamPublicBaseUrl } from '../../common/stream-public-base-url.util';
import { SettingsService } from '../settings/settings.service';
import { cookieOpts, clearOpts } from './cookie-opts.util';
import { getRequestCookieHeader, parseCookieValue } from './request-cookie.util';
import type { JwtPayload } from './strategies/jwt.strategy';
import { EventsService } from '../scheduler/events.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly settingsService: SettingsService,
    private readonly jwtService: JwtService,
    private readonly events: EventsService,
  ) {}

  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('user-agent') userAgent?: string,
  ) {
    const result = await this.authService.login(dto);
    const maxAgeMs = this.authService.getAccessCookieMaxAgeMs();
    res.cookie(
      ACCESS_TOKEN_COOKIE,
      result.accessToken,
      cookieOpts(req, maxAgeMs),
    );
    // \`accessToken\` returned in the JSON body too — native clients
    // attach it as Bearer (they ignore the cookie). \`refreshToken\`
    // is JSON-only (no cookie) so it never travels on regular API
    // requests, which keeps it away from XSRF concerns.
    return result;
  }

  /**
   * Exchange a refresh token for a fresh access + refresh pair.
   * The presented refresh token is invalidated atomically; the new
   * one rotates in. Theft detection: if a previously-rotated token
   * is replayed, every refresh token of the user is revoked and the
   * call fails — every device has to log back in.
   */
  @Post('refresh')
  async refresh(
    @Body('refreshToken') refreshToken: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('user-agent') userAgent?: string,
  ) {
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }
    const tokens = await this.authService.refresh(refreshToken, userAgent);
    const maxAgeMs = this.authService.getAccessCookieMaxAgeMs();
    res.cookie(
      ACCESS_TOKEN_COOKIE,
      tokens.accessToken,
      cookieOpts(req, maxAgeMs),
    );
    return tokens;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('refreshToken') refreshToken?: string,
  ) {
    res.clearCookie(ACCESS_TOKEN_COOKIE, clearOpts(req));
    // Revoke the refresh token server-side. Best-effort: a malformed
    // or already-revoked token is silently ignored — the cookie is
    // gone either way and the access token will expire on its own.
    if (refreshToken) {
      try {
        await this.authService.revokeRefreshToken(refreshToken);
      } catch {
        // ignore
      }
    }
    // Drop this user's SSE connections now, not at token expiry: otherwise a
    // logged-out device stays a listed, commandable remote-control target for
    // up to the access token's remaining lifetime.
    const accessToken =
      parseCookieValue(getRequestCookieHeader(req), ACCESS_TOKEN_COOKIE) ??
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null);
    if (accessToken) {
      try {
        const payload = this.jwtService.verify<JwtPayload>(accessToken);
        this.events.dropConnectionsForUser(payload.sub);
      } catch {
        // expired/invalid access token: no live connection to attribute this to
      }
    }
  }

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Get('me')
  @UseGuards(JwtOrApiKeyGuard)
  async getProfile(@CurrentUser() user: User) {
    // Bump the user's lastLogin column so the admin user list reflects "last
    // active" rather than just "last login". Throttled inside touchActivity()
    // so frequent /auth/me polls don't hammer the DB.
    await this.authService.touchActivity(user);
    return this.authService.safeUser(user);
  }

  /**
   * Public user list for the pre-login picker. Exposes only
   * id/username/avatar, never email/role/lastLogin.
   */
  @Get('users-public')
  publicUsers() {
    return this.authService.publicUserList();
  }

  /**
   * JWT Cast (4h) + base d’URL des flux (EXTERNAL_URL / Host).
   * À appeler juste avant loadMedia côté client pour limiter l’écart avec les requêtes du receiver.
   */
  @Post('cast-info')
  @UseGuards(JwtOrApiKeyGuard)
  async castInfo(@CurrentUser() user: User, @Req() req: Request) {
    const token = this.authService.generateCastToken(user);
    const publicUrl = await this.settingsService.get('public_url');
    const streamBaseUrl = resolveStreamPublicBaseUrl(req, publicUrl);
    return { token, streamBaseUrl };
  }

  /**
   * Long-lived stream JWT (12h) used by the player + offline-download
   * flow. The 1h access token isn't suitable for ExoPlayer / AVPlay /
   * Shaka — they bake the auth header at \`load()\` time and never
   * re-ask Angular, so a film longer than the token TTL would break
   * mid-playback. See AuthService.generateStreamToken.
   */
  @Post('stream-token')
  @UseGuards(JwtOrApiKeyGuard)
  streamToken(@CurrentUser() user: User) {
    const token = this.authService.generateStreamToken(user);
    const ttlMs = this.authService.getStreamTokenTtlMs();
    return { streamToken: token, expiresAt: Date.now() + ttlMs };
  }
}
