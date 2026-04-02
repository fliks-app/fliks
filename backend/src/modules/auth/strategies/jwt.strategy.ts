import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { User } from '../../users/entities/user.entity';
import { ACCESS_TOKEN_COOKIE } from '../auth.constants';
import {
  getRequestCookieHeader,
  parseCookieValue,
} from '../request-cookie.util';

export interface JwtPayload {
  sub: number;
  username: string;
}

const jwtLog = new Logger('JwtExtract');

function jwtFromCookie(req: Request): string | null {
  const cookieHeader = getRequestCookieHeader(req);
  const token = parseCookieValue(cookieHeader, ACCESS_TOKEN_COOKIE);
  const origin = req.headers.origin ?? '(none)';
  jwtLog.debug(
    `origin=${origin} hasCookie=${!!cookieHeader} tokenFound=${!!token} cookiePreview=${cookieHeader?.substring(0, 60) ?? '(empty)'}`,
  );
  return token;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        jwtFromCookie,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<User> {
    const user = await this.userRepo.findOne({
      where: { id: payload.sub, enabled: true },
      relations: ['userRole'],
    });
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }
}
