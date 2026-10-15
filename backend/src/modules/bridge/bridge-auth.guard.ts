import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/** Bearer check against FLIKS_BRIDGE_TOKEN; 503 when the token is not configured. */
@Injectable()
export class BridgeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.FLIKS_BRIDGE_TOKEN;
    if (!expected) throw new ServiceUnavailableException('bridge disabled');
    const header = context.switchToHttp().getRequest<Request>()
      .headers.authorization;
    const given = Buffer.from(
      header?.startsWith('Bearer ') ? header.slice(7) : '',
    );
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
