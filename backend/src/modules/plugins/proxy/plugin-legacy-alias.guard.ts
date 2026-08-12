import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { PluginRegistryService } from '../plugin-registry.service';
import { CaslAbilityFactory } from '../../auth/casl/casl-ability.factory';
import { PluginObjectGuardsService } from './plugin-object-guards.service';
import { checkPolicyAndObjectGuard } from './plugin-route.guard';
import type { User } from '../../users/entities/user.entity';

export const RESOLVED_LEGACY_ALIAS_KEY = 'pluginLegacyAlias' as const;

export type PluginLegacyAliasRequest = Request & {
  user?: User;
  [RESOLVED_LEGACY_ALIAS_KEY]?: { pluginId: string; targetPath: string };
};

function requestPath(req: Request): string {
  return req.originalUrl.split('?')[0];
}

/** Runs before `JwtOrApiKeyGuard`: a URL matching no plugin's `legacyPaths` must 404 exactly as
 *  it always has, never demand authentication for a path that answers to nothing at all. */
@Injectable()
export class PluginLegacyAliasMatchGuard implements CanActivate {
  constructor(private readonly registry: PluginRegistryService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!this.registry.resolveLegacyAlias(req.method, requestPath(req))) {
      throw new NotFoundException();
    }
    return true;
  }
}

/** Runs after `JwtOrApiKeyGuard`: re-resolves the alias and enforces its *target* route's own
 *  policy and objectGuard — an alias must never carry a looser check than the route it stands in for. */
@Injectable()
export class PluginLegacyAliasPolicyGuard implements CanActivate {
  constructor(
    private readonly registry: PluginRegistryService,
    private readonly objectGuards: PluginObjectGuardsService,
    private readonly caslAbilityFactory: CaslAbilityFactory,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PluginLegacyAliasRequest>();
    const alias = this.registry.resolveLegacyAlias(req.method, requestPath(req));
    if (!alias) throw new NotFoundException();
    if (!req.user) return false;

    const declaredSubjects = this.registry.declaredPermissionsFor(alias.pluginId);
    if (!(await checkPolicyAndObjectGuard(alias.resolved, req.user, declaredSubjects, this.caslAbilityFactory, this.objectGuards))) {
      return false;
    }

    req[RESOLVED_LEGACY_ALIAS_KEY] = { pluginId: alias.pluginId, targetPath: alias.targetPath };
    return true;
  }
}
