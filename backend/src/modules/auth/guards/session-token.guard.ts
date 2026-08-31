import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { RequestWithTokenScope } from '../strategies/jwt.strategy';

/**
 * Rejects a scoped token on a route that acts on the user's behalf.
 *
 * Stream and Cast tokens are long-lived and travel in plain URLs: baked into
 * every manifest, segment, subtitle and thumbnail request, and handed to the
 * Cast receiver. They must stay read-only, so any route that changes state or
 * enumerates the user's devices declares this guard.
 */
@Injectable()
export class SessionTokenGuard implements CanActivate {
  private readonly logger = new Logger(SessionTokenGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithTokenScope>();
    if (req.tokenScope) {
      this.logger.warn(
        `Rejected ${req.method} ${req.url}: token scope '${req.tokenScope}' may not act on the account`,
      );
      throw new ForbiddenException('session_token_required');
    }
    return true;
  }
}
