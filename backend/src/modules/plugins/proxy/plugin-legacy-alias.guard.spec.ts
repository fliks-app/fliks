import { NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import {
  PluginLegacyAliasMatchGuard,
  PluginLegacyAliasPolicyGuard,
  RESOLVED_LEGACY_ALIAS_KEY,
  type PluginLegacyAliasRequest,
} from './plugin-legacy-alias.guard';
import type { User } from '../../users/entities/user.entity';

function fakeRequest(
  overrides: Partial<PluginLegacyAliasRequest> = {},
): PluginLegacyAliasRequest {
  return {
    method: 'GET',
    originalUrl: '/api/media/7/releases',
    ...overrides,
  } as unknown as PluginLegacyAliasRequest;
}

function fakeContext(req: PluginLegacyAliasRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('PluginLegacyAliasMatchGuard', () => {
  it('throws NotFoundException, not a plugin-flavoured error, when nothing declares this alias', () => {
    const registry = { resolveLegacyAlias: jest.fn().mockReturnValue(null) };
    const guard = new PluginLegacyAliasMatchGuard(registry as never);

    expect(() => guard.canActivate(fakeContext(fakeRequest()))).toThrow(
      NotFoundException,
    );
  });

  it('permits, without needing req.user, when an alias matches', () => {
    const registry = {
      resolveLegacyAlias: jest.fn().mockReturnValue({
        pluginId: 'fliks.testplugin',
        targetPath: '/7/releases',
        resolved: {},
      }),
    };
    const guard = new PluginLegacyAliasMatchGuard(registry as never);

    expect(guard.canActivate(fakeContext(fakeRequest()))).toBe(true);
  });

  it('strips the query string before matching', () => {
    const registry = {
      resolveLegacyAlias: jest
        .fn()
        .mockReturnValue({ pluginId: 'x', targetPath: '/7', resolved: {} }),
    };
    const guard = new PluginLegacyAliasMatchGuard(registry as never);

    guard.canActivate(
      fakeContext(fakeRequest({ originalUrl: '/api/media/7/releases?x=1' })),
    );

    expect(registry.resolveLegacyAlias).toHaveBeenCalledWith(
      'GET',
      '/api/media/7/releases',
    );
  });
});

describe('PluginLegacyAliasPolicyGuard', () => {
  function makeGuard(alias: unknown, canReturns = true) {
    const registry = {
      resolveLegacyAlias: jest.fn().mockReturnValue(alias),
      declaredPermissionsFor: jest.fn().mockReturnValue(new Set<string>()),
    };
    const objectGuards = { check: jest.fn().mockResolvedValue(true) };
    const caslAbilityFactory = {
      createForUser: jest
        .fn()
        .mockReturnValue({ can: jest.fn().mockReturnValue(canReturns) }),
    };
    const guard = new PluginLegacyAliasPolicyGuard(
      registry as never,
      objectGuards as never,
      caslAbilityFactory as never,
    );
    return { guard, registry, objectGuards, caslAbilityFactory };
  }

  it('throws NotFoundException if the alias no longer resolves (plugin uninstalled mid-request)', async () => {
    const { guard } = makeGuard(null);
    await expect(
      guard.canActivate(fakeContext(fakeRequest({ user: { id: 1 } as User }))),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses when there is no req.user, even though the alias resolved', async () => {
    const { guard } = makeGuard({
      pluginId: 'fliks.testplugin',
      targetPath: '/7',
      resolved: { route: { policy: 'read:Media' }, params: {} },
    });
    await expect(
      guard.canActivate(fakeContext(fakeRequest({ user: undefined }))),
    ).resolves.toBe(false);
  });

  it("refuses when the target route's policy is denied by the ability", async () => {
    const { guard } = makeGuard(
      {
        pluginId: 'fliks.testplugin',
        targetPath: '/7',
        resolved: { route: { policy: 'read:Media' }, params: {} },
      },
      false,
    );
    await expect(
      guard.canActivate(fakeContext(fakeRequest({ user: { id: 1 } as User }))),
    ).resolves.toBe(false);
  });

  it("refuses when the target route's objectGuard denies the captured param", async () => {
    const { guard, objectGuards } = makeGuard({
      pluginId: 'fliks.testplugin',
      targetPath: '/7/releases',
      resolved: {
        route: { policy: 'read:Media', objectGuard: 'mediaAccessible:id' },
        params: { id: '7' },
      },
    });
    objectGuards.check.mockResolvedValue(false);
    await expect(
      guard.canActivate(fakeContext(fakeRequest({ user: { id: 1 } as User }))),
    ).resolves.toBe(false);
    expect(objectGuards.check).toHaveBeenCalledWith('mediaAccessible', '7', {
      id: 1,
    });
  });

  it('permits and stashes the resolved alias on the request when every step passes', async () => {
    const alias = {
      pluginId: 'fliks.testplugin',
      targetPath: '/7/releases',
      resolved: { route: { policy: 'read:Media' }, params: {} },
    };
    const { guard } = makeGuard(alias);
    const req = fakeRequest({ user: { id: 1 } as User });

    await expect(guard.canActivate(fakeContext(req))).resolves.toBe(true);

    expect(req[RESOLVED_LEGACY_ALIAS_KEY]).toEqual({
      pluginId: 'fliks.testplugin',
      targetPath: '/7/releases',
    });
  });

  it("scopes the CASL check to the target's own plugin id, not any other installed plugin", async () => {
    const alias = {
      pluginId: 'fliks.testplugin',
      targetPath: '/7',
      resolved: { route: { policy: 'read:Media' }, params: {} },
    };
    const { guard, registry } = makeGuard(alias);

    await guard.canActivate(
      fakeContext(fakeRequest({ user: { id: 1 } as User })),
    );

    expect(registry.declaredPermissionsFor).toHaveBeenCalledWith(
      'fliks.testplugin',
    );
  });
});
