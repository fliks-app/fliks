import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Res,
  Req,
  HttpCode,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from './dto/login.dto';
import { JwtOrApiKeyGuard } from './guards/jwt-or-api-key.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { ACCESS_TOKEN_COOKIE } from './auth.constants';
import { resolveStreamPublicBaseUrl } from '../../common/stream-public-base-url.util';
import { SettingsService } from '../settings/settings.service';
import { cookieOpts, clearOpts } from './cookie-opts.util';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly settingsService: SettingsService,
  ) {}

  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, user } = await this.authService.login(dto);
    const maxAgeMs = this.authService.getAccessCookieMaxAgeMs();
    res.cookie(ACCESS_TOKEN_COOKIE, accessToken, cookieOpts(req, maxAgeMs));
    return { user, accessToken };
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.clearCookie(ACCESS_TOKEN_COOKIE, clearOpts(req));
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
}
