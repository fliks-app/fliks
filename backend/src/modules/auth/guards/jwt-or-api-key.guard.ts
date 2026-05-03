import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// TODO: réintroduire l'API key auth au niveau application (clé globale dans app_settings)
// Ancien fonctionnement : AuthGuard(['jwt', 'api-key']) avec ApiKeyStrategy lisant le header X-Api-Key
@Injectable()
export class JwtOrApiKeyGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }
}
