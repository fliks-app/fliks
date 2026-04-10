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

const NATIVE_ORIGINS = [
  'https://localhost',
  'capacitor://localhost',
  'http://localhost',
];

function isCrossOriginNative(req: Request): boolean {
  const origin = req.headers.origin ?? '';
  return NATIVE_ORIGINS.includes(origin);
}

function cookieOpts(req: Request, maxAgeMs: number) {
  if (isCrossOriginNative(req)) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'none' as const,
      path: '/',
      maxAge: maxAgeMs,
    };
  }
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeMs,
  };
}

function clearOpts(req: Request) {
  if (isCrossOriginNative(req)) {
    return {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'none' as const,
    };
  }
  return {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
  };
}

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
  getProfile(@CurrentUser() user: User) {
    return this.authService.safeUser(user);
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
