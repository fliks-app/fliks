import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PluginRegistryService } from '../plugin-registry.service';
import type { ResolvedPluginRoute } from './plugin-route-table';
import { CaslAbilityFactory } from '../../auth/casl/casl-ability.factory';
import { PluginObjectGuardsService, parseObjectGuard } from './plugin-object-guards.service';
import { checkDeclaredPolicy } from './policy-vocabulary';
import type { User } from '../../users/entities/user.entity';

export const RESOLVED_PLUGIN_ROUTE_KEY = 'pluginRoute' as const;

export type PluginRouteRequest = Request & {
  user?: User;
  [RESOLVED_PLUGIN_ROUTE_KEY]?: ResolvedPluginRoute;
};

/** The raw (still percent-encoded) sub-path after `/plugins/<pluginId>` — rebuilding it from
 *  `req.params.splat` would lose a `%2F` folded inside one segment's already-decoded value. */
export function pluginRequestPath(req: Request): string {
  const rawPath = req.originalUrl.split('?')[0];
  const marker = rawPath.indexOf('/plugins/');
  if (marker === -1) return '';
  const afterPluginId = rawPath.slice(marker + '/plugins/'.length);
  const nextSlash = afterPluginId.indexOf('/');
  return nextSlash === -1 ? '' : afterPluginId.slice(nextSlash);
}

/** Stands in for `PoliciesGuard`, which reads `@CheckPolicies` from the handler — every request
 *  here hits the same handler, so the policy has to come from the resolved route instead. */
@Injectable()
export class PluginRouteGuard implements CanActivate {
  constructor(
    private readonly registry: PluginRegistryService,
    private readonly objectGuards: PluginObjectGuardsService,
    private readonly caslAbilityFactory: CaslAbilityFactory,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PluginRouteRequest>();
    const pluginId = req.params.pluginId;
    if (typeof pluginId !== 'string') return false;

    const resolved = this.registry.resolveRoute(pluginId, req.method, pluginRequestPath(req));
    if (!resolved) return false;

    if (!req.user) return false;

    const ability = this.caslAbilityFactory.createForUser(req.user);
    if (!checkDeclaredPolicy(resolved.route.policy, ability)) return false;

    if (resolved.route.objectGuard) {
      const parsedGuard = parseObjectGuard(resolved.route.objectGuard);
      if (!parsedGuard) return false;
      const value = resolved.params[parsedGuard.paramName];
      if (typeof value !== 'string') return false;
      if (!(await this.objectGuards.check(parsedGuard.guard, value, req.user))) return false;
    }

    req[RESOLVED_PLUGIN_ROUTE_KEY] = resolved;
    return true;
  }
}
