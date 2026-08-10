import type { ExecutionContext } from '@nestjs/common';
import { PluginRouteGuard, pluginRequestPath, RESOLVED_PLUGIN_ROUTE_KEY, type PluginRouteRequest } from './plugin-route.guard';
import type { User } from '../../users/entities/user.entity';

describe('pluginRequestPath', () => {
  it.each([
    ['/api/plugins/fliks.testplugin/queue', '/queue'],
    ['/api/plugins/fliks.testplugin/releases/40%2Fadmin', '/releases/40%2Fadmin'],
    ['/api/plugins/fliks.testplugin', ''],
    // pluginId literally "plugins" — the *first* "/plugins/" in the raw URL is still ours.
    ['/api/plugins/plugins/queue', '/queue'],
  ])('extracts the raw remainder from %s', (originalUrl, expected) => {
    expect(pluginRequestPath({ originalUrl } as never)).toBe(expected);
  });

  it('strips the query string before extracting the remainder', () => {
    expect(pluginRequestPath({ originalUrl: '/api/plugins/x/queue?a=1' } as never)).toBe('/queue');
  });
});

function fakeRequest(overrides: Partial<PluginRouteRequest> = {}): PluginRouteRequest {
  return {
    method: 'GET',
    originalUrl: '/api/plugins/fliks.testplugin/queue',
    params: { pluginId: 'fliks.testplugin' },
    ...overrides,
  } as unknown as PluginRouteRequest;
}

function fakeContext(req: PluginRouteRequest): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('PluginRouteGuard', () => {
  function makeGuard(resolvedRoute: unknown, canReturns = true) {
    const registry = {
      resolveRoute: jest.fn().mockReturnValue(resolvedRoute),
      declaredPermissionsFor: jest.fn().mockReturnValue(new Set<string>()),
    };
    const objectGuards = { check: jest.fn().mockResolvedValue(true) };
    const caslAbilityFactory = { createForUser: jest.fn().mockReturnValue({ can: jest.fn().mockReturnValue(canReturns) }) };
    const guard = new PluginRouteGuard(registry as never, objectGuards as never, caslAbilityFactory as never);
    return { guard, registry, objectGuards, caslAbilityFactory };
  }

  it('step 1: refuses when the route does not resolve', async () => {
    const { guard, caslAbilityFactory } = makeGuard(null);
    const req = fakeRequest({ user: { id: 1 } as User });
    await expect(guard.canActivate(fakeContext(req))).resolves.toBe(false);
    // Never even builds an ability for a route that isn't declared.
    expect(caslAbilityFactory.createForUser).not.toHaveBeenCalled();
  });

  it('step 2: refuses when there is no req.user, even though the route resolved', async () => {
    const { guard } = makeGuard({ route: { policy: 'read:Media' }, params: {} });
    const req = fakeRequest({ user: undefined });
    await expect(guard.canActivate(fakeContext(req))).resolves.toBe(false);
  });

  it('step 3: refuses when the declared policy is denied by the ability', async () => {
    const { guard } = makeGuard({ route: { policy: 'read:Media' }, params: {} }, false);
    const req = fakeRequest({ user: { id: 1 } as User });
    await expect(guard.canActivate(fakeContext(req))).resolves.toBe(false);
  });

  it('step 4: refuses when the route\'s objectGuard denies the captured param', async () => {
    const { guard, objectGuards } = makeGuard({
      route: { policy: 'read:Media', objectGuard: 'mediaAccessible:id' },
      params: { id: '42' },
    });
    objectGuards.check.mockResolvedValue(false);
    const req = fakeRequest({ user: { id: 1 } as User });
    await expect(guard.canActivate(fakeContext(req))).resolves.toBe(false);
    expect(objectGuards.check).toHaveBeenCalledWith('mediaAccessible', '42', req.user);
  });

  it('step 4: refuses when the captured param is missing from the matched route', async () => {
    const { guard, objectGuards } = makeGuard({
      route: { policy: 'read:Media', objectGuard: 'mediaAccessible:id' },
      params: {},
    });
    const req = fakeRequest({ user: { id: 1 } as User });
    await expect(guard.canActivate(fakeContext(req))).resolves.toBe(false);
    expect(objectGuards.check).not.toHaveBeenCalled();
  });

  it('refuses a route whose objectGuard fails to parse (registration should already have refused this manifest)', async () => {
    const { guard } = makeGuard({ route: { policy: 'read:Media', objectGuard: 'not-a-guard' }, params: {} });
    const req = fakeRequest({ user: { id: 1 } as User });
    await expect(guard.canActivate(fakeContext(req))).resolves.toBe(false);
  });

  it('permits and stashes the resolved route on the request when every step passes', async () => {
    const resolved = { route: { policy: 'read:Media' }, params: {} };
    const { guard } = makeGuard(resolved);
    const req = fakeRequest({ user: { id: 1 } as User });
    await expect(guard.canActivate(fakeContext(req))).resolves.toBe(true);
    expect(req[RESOLVED_PLUGIN_ROUTE_KEY]).toBe(resolved);
  });

  it('permits a route with a satisfied objectGuard', async () => {
    const resolved = { route: { policy: 'read:Media', objectGuard: 'mediaAccessible:id' }, params: { id: '7' } };
    const { guard, objectGuards } = makeGuard(resolved);
    const req = fakeRequest({ user: { id: 1 } as User });
    await expect(guard.canActivate(fakeContext(req))).resolves.toBe(true);
    expect(objectGuards.check).toHaveBeenCalledWith('mediaAccessible', '7', req.user);
  });
});
