import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { User } from '../../users/entities/user.entity';
import { ACCESS_TOKEN_COOKIE } from '../auth.constants';
import {
  getRequestCookieHeader,
  parseCookieValue,
} from '../request-cookie.util';
import { getJwtSecret } from '../../../common/utils/jwt-secret';

export interface JwtPayload {
  sub: number;
  username: string;
  /** Absent on a full session token. `'stream'` marks the long-lived tokens
   *  baked into manifest/segment/subtitle URLs and handed to the Cast
   *  receiver: they may read streams and nothing else. */
  scope?: 'stream';
}

function jwtFromCookie(req: Request): string | null {
  return parseCookieValue(getRequestCookieHeader(req), ACCESS_TOKEN_COOKIE);
}

function jwtFromQueryParam(req: Request): string | null {
  return (req.query?.token as string) ?? null;
}

/** Request decorated by {@link JwtStrategy.validate} with the token's scope. */
export interface RequestWithTokenScope extends Request {
  tokenScope?: 'stream' | null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        jwtFromCookie,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        jwtFromQueryParam,
      ]),
      ignoreExpiration: false,
      // The scope has to reach the guards, and `validate` can only return the
      // user: so stash it on the request.
      passReqToCallback: true,
      // Same resolution chain as the JwtModule signing key:
      // JWT_SECRET env > <conf-dir>/.jwt-secret > auto-generated.
      secretOrKey: getJwtSecret(),
    });
  }

  async validate(req: Request, payload: JwtPayload): Promise<User> {
    const user = await this.userRepo.findOne({
      where: { id: payload.sub, enabled: true },
      relations: ['userRole'],
    });
    if (!user) {
      throw new UnauthorizedException();
    }
    (req as RequestWithTokenScope).tokenScope = payload.scope ?? null;
    return user;
  }
}
