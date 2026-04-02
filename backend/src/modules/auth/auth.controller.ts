import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Res,
  Req,
  HttpCode,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from './dto/login.dto';
import { JwtOrApiKeyGuard } from './guards/jwt-or-api-key.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { ACCESS_TOKEN_COOKIE } from './auth.constants';

const NATIVE_ORIGINS = ['https://localhost', 'capacitor://localhost', 'http://localhost'];

function isCrossOriginNative(req: Request): boolean {
  const origin = req.headers.origin ?? '';
  return NATIVE_ORIGINS.includes(origin);
}

function cookieOpts(req: Request, maxAgeMs: number) {
  if (isCrossOriginNative(req)) {
    return { httpOnly: true, secure: true, sameSite: 'none' as const, path: '/', maxAge: maxAgeMs };
  }
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', maxAge: maxAgeMs };
}

function clearOpts(req: Request) {
  if (isCrossOriginNative(req)) {
    return { path: '/', httpOnly: true, secure: true, sameSite: 'none' as const };
  }
  return { path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const };
}

@Controller('auth')
export class AuthController {
  private readonly log = new Logger('AuthController');

  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const origin = req.headers.origin ?? '(none)';
    const crossOrigin = isCrossOriginNative(req);
    this.log.log(`LOGIN origin=${origin} crossOrigin=${crossOrigin} user=${dto.username}`);
    const { accessToken, user } = await this.authService.login(dto);
    const maxAgeMs = this.authService.getAccessCookieMaxAgeMs();
    const opts = cookieOpts(req, maxAgeMs);
    this.log.log(`LOGIN cookie opts: sameSite=${opts.sameSite} secure=${opts.secure} httpOnly=${opts.httpOnly} maxAge=${opts.maxAge}`);
    res.cookie(ACCESS_TOKEN_COOKIE, accessToken, opts);
    return { user, accessToken };
  }

  @Post('logout')
  @HttpCode(204)
  logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.clearCookie(ACCESS_TOKEN_COOKIE, clearOpts(req));
  }

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Get('me')
  @UseGuards(JwtOrApiKeyGuard)
  getProfile(@CurrentUser() user: User, @Req() req: Request) {
    const origin = req.headers.origin ?? '(none)';
    const cookie = req.headers.cookie ? req.headers.cookie.substring(0, 80) + '...' : '(none)';
    this.log.log(`GET /me origin=${origin} cookie=${cookie} userId=${user.id}`);
    return this.authService.safeUser(user);
  }
}
