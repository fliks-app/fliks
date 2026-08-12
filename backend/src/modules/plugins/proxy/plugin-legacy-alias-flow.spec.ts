import { Controller, INestApplication, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PluginRegistryService } from '../plugin-registry.service';
import { PluginPackage } from '../entities/plugin-package.entity';
import { minimalProcessManifest } from '../archive/test-manifests';
import { fakeRegistrationRepo, fakeProcessService, fakePluginJobsService, fakeScheduledJobRegistry } from '../plugin-registry.test-helpers';
import { PluginProcessService } from '../plugin-process.service';
import { PluginLegacyAliasController } from './plugin-legacy-alias.controller';
import { PluginLegacyAliasMatchGuard, PluginLegacyAliasPolicyGuard } from './plugin-legacy-alias.guard';
import { PluginObjectGuardsService } from './plugin-object-guards.service';
import { CaslAbilityFactory } from '../../auth/casl/casl-ability.factory';
import { JwtOrApiKeyGuard } from '../../auth/guards/jwt-or-api-key.guard';
import { User } from '../../users/entities/user.entity';
import type { PluginManifest, PluginRoute } from '../../../common/plugin-contract';

/** No route in this suite ever declares an `objectGuard`; a plain object satisfies the
 *  controller's DI without ever needing a real `.check()`. */
@Controller()
class NoopController {}

function makePackage(manifest: PluginManifest): PluginPackage {
  return {
    id: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    pluginId: manifest.id,
    version: manifest.version,
    archive: Buffer.alloc(0),
    origin: 'manual',
    signature: 'unsigned',
    verifiedByKeyId: null,
    manifest,
    status: 'active',
  } as PluginPackage;
}

function processManifest(routes: PluginRoute[], legacyPaths: Record<string, string>) {
  return minimalProcessManifest(
    { 'plugin.js': 'a'.repeat(64), 'logo.png': 'b'.repeat(64) },
    { id: 'fliks.testplugin', fliks: '>=1.0.0 <3.0.0', routes, legacyPaths },
  );
}

describe('legacyPaths — end-to-end alias resolution', () => {
  let app: INestApplication;
  let processService: ReturnType<typeof fakeProcessService> & { callPlugin: jest.Mock };
  let currentUser: User | undefined;

  beforeAll(async () => {
    // `fakeProcessService` only covers what `PluginRegistryService` calls; the controller
    // also needs `callPlugin`, which lives solely on the real `PluginProcessService`.
    processService = { ...fakeProcessService(), callPlugin: jest.fn() };
    const registry = new PluginRegistryService(
      { find: jest.fn().mockResolvedValue([]) } as never,
      fakeRegistrationRepo() as never,
      processService as never,
      fakePluginJobsService() as never,
      fakeScheduledJobRegistry() as never,
    );
    const manifest = processManifest(
      [
        { method: 'GET', path: '/:id/releases', policy: 'read:Media' },
        { method: 'GET', path: '/:id/seasons/:seasonId/releases', policy: 'read:Media' },
      ],
      {
        'GET /api/media/:id/releases': 'GET /:id/releases',
        'GET /api/media/:id/seasons/:seasonId/releases': 'GET /:id/seasons/:seasonId/releases',
      },
    );
    const registered = await registry.register(makePackage(manifest));
    expect(registered).toEqual({ ok: true, pluginId: manifest.id });

    const moduleRef = await Test.createTestingModule({
      controllers: [NoopController, PluginLegacyAliasController],
      providers: [
        { provide: PluginRegistryService, useValue: registry },
        { provide: PluginProcessService, useValue: processService },
        PluginLegacyAliasMatchGuard,
        PluginLegacyAliasPolicyGuard,
        { provide: PluginObjectGuardsService, useValue: { check: jest.fn() } },
        CaslAbilityFactory,
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          if (!currentUser) throw new UnauthorizedException();
          const req = ctx.switchToHttp().getRequest<Record<string, unknown>>();
          req.user = currentUser;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // `permissions` is a getter on the real class — a plain object literal wouldn't have it.
    currentUser = Object.assign(new User(), { id: 1, isAdmin: true });
    processService.stateOf.mockReturnValue('ready');
    processService.callPlugin.mockReset();
  });

  it('reaches the target route with the alias params substituted, query and body passed through', async () => {
    processService.callPlugin.mockResolvedValue({ status: 200, headers: {}, body: { ok: true } });

    await request(app.getHttpServer()).get('/api/media/7/releases?lang=en').expect(200);

    expect(processService.callPlugin).toHaveBeenCalledWith(
      'fliks.testplugin',
      'http',
      { method: 'GET', path: '/7/releases', query: { lang: 'en' }, body: undefined, principal: { kind: 'delegated', userId: 1 } },
      30_000,
    );
  });

  it('substitutes both params of a nested alias', async () => {
    processService.callPlugin.mockResolvedValue({ status: 200, headers: {}, body: {} });

    await request(app.getHttpServer()).get('/api/media/7/seasons/3/releases').expect(200);

    expect(processService.callPlugin).toHaveBeenCalledWith(
      'fliks.testplugin',
      'http',
      expect.objectContaining({ path: '/7/seasons/3/releases' }),
      30_000,
    );
  });

  it('503s when the plugin is not ready, same as the direct proxy', async () => {
    processService.stateOf.mockReturnValue('crashed');

    await request(app.getHttpServer()).get('/api/media/7/releases').expect(503);

    expect(processService.callPlugin).not.toHaveBeenCalled();
  });

  it('404s a URL matching no alias, before ever checking authentication', async () => {
    currentUser = undefined;

    await request(app.getHttpServer()).get('/api/media/7/upgrade-releases').expect(404);
  });

  it('401s (never 404s) a URL that matches a declared alias when unauthenticated', async () => {
    currentUser = undefined;

    await request(app.getHttpServer()).get('/api/media/7/releases').expect(401);
  });
});
