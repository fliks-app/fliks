import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtOrApiKeyGuard extends AuthGuard(['jwt', 'api-key']) {
  canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }
}
