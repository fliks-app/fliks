import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { User } from '../../users/entities/user.entity';
import { CaslAbilityFactory, AppAbility } from './casl-ability.factory';
import { CHECK_POLICIES_KEY, PolicyHandler } from './check-policies.decorator';

@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private caslAbilityFactory: CaslAbilityFactory,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Handler wins over class so a controller-wide default can be tightened per route.
    const policyHandlers =
      this.reflector.getAllAndOverride<PolicyHandler[]>(CHECK_POLICIES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    // Fail closed: a handler under this guard that declares no policy is denied,
    // so forgetting `@CheckPolicies` cannot silently expose it to every account.
    if (policyHandlers.length === 0) {
      return false;
    }

    const { user } = context
      .switchToHttp()
      .getRequest<Request & { user?: User }>();
    if (!user) {
      return false;
    }

    const ability = this.caslAbilityFactory.createForUser(user);

    return policyHandlers.every((handler) =>
      execPolicyHandler(handler, ability),
    );
  }
}

function execPolicyHandler(
  handler: PolicyHandler,
  ability: AppAbility,
): boolean {
  if (typeof handler === 'function') {
    return handler(ability);
  }
  return handler.handle(ability);
}
