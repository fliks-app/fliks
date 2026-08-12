import { Controller, Get, INestApplication, Param } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { PluginsController } from './plugins.controller';
import { PluginLogoController } from './plugin-logo.controller';
import { PluginSourcesController } from './plugin-sources.controller';
import { PluginImportController } from './plugin-import.controller';
import { PluginProxyController } from './proxy/plugin-proxy.controller';
import { PluginRouteGuard } from './proxy/plugin-route.guard';
import { PluginLegacyAliasController } from './proxy/plugin-legacy-alias.controller';
import { PluginLegacyAliasMatchGuard, PluginLegacyAliasPolicyGuard, RESOLVED_LEGACY_ALIAS_KEY } from './proxy/plugin-legacy-alias.guard';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginInstallService } from './plugin-install.service';
import { PluginCatalogClientService } from './plugin-catalog-client.service';
import { PluginProcessService } from './plugin-process.service';
import { PluginSource } from './entities/plugin-source.entity';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';

/** Stands in for a real core controller (e.g. `MediaController`) — same route shape, none of its
 *  dependencies — to prove the ordering mechanism protects any core route, not just plugin ones. */
@Controller('media')
class FakeMediaController {
  @Get(':id')
  get(@Param('id') id: string) {
    return { id };
  }
}

/** Every guard is stubbed to permit, so a request's outcome depends only on which controller's
 *  handler Express actually dispatches to — this proves registration order, not policy logic. */
describe('plugins/* route shadowing', () => {
  let app: INestApplication;
  let installService: Record<string, jest.Mock>;
  let registry: Record<string, jest.Mock>;
  let catalogClient: Record<string, jest.Mock>;
  let processService: Record<string, jest.Mock>;
  let sourceRepo: Record<string, jest.Mock>;

  beforeAll(async () => {
    installService = {
      listInstalled: jest.fn().mockResolvedValue([]),
      setEnabled: jest.fn().mockResolvedValue({}),
      restart: jest.fn().mockResolvedValue(undefined),
      uninstall: jest.fn().mockResolvedValue(undefined),
      confirmImport: jest.fn().mockResolvedValue({}),
    };
    registry = {
      get: jest.fn().mockReturnValue(undefined),
      processStateOf: jest.fn().mockReturnValue(null),
      processStatusMessageOf: jest.fn().mockReturnValue(''),
    };
    catalogClient = {};
    processService = { callPlugin: jest.fn() };
    sourceRepo = { find: jest.fn().mockResolvedValue([]) };

    const moduleRef = await Test.createTestingModule({
      controllers: [
        // Mirrors AppModule: MediaModule (and every other feature module) is imported before
        // PluginsModule, so its routes are always registered first.
        FakeMediaController,
        PluginLogoController,
        PluginSourcesController,
        PluginImportController,
        PluginsController,
        // Last on purpose — mirrors plugins.module.ts's controllers[] order.
        PluginProxyController,
        // Last of all — a legacy alias must never get a chance to shadow anything above.
        PluginLegacyAliasController,
      ],
      providers: [
        { provide: PluginRegistryService, useValue: registry },
        { provide: PluginInstallService, useValue: installService },
        { provide: PluginCatalogClientService, useValue: catalogClient },
        { provide: PluginProcessService, useValue: processService },
        { provide: getRepositoryToken(PluginSource), useValue: sourceRepo },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PoliciesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PluginRouteGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PluginLegacyAliasMatchGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PluginLegacyAliasPolicyGuard)
      .useValue({
        canActivate: (ctx: import('@nestjs/common').ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<Record<string, unknown>>();
          req[RESOLVED_LEGACY_ALIAS_KEY] = { pluginId: 'fliks.testplugin', targetPath: '/x' };
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

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('GET /plugins reaches PluginsController.list, not the proxy', async () => {
    await request(app.getHttpServer()).get('/plugins').expect(200);
    expect(installService.listInstalled).toHaveBeenCalledTimes(1);
    expect(processService.callPlugin).not.toHaveBeenCalled();
  });

  it('DELETE /plugins/:pluginId reaches PluginsController.uninstall, not the proxy', async () => {
    await request(app.getHttpServer()).delete('/plugins/fliks.testplugin').expect(204);
    expect(installService.uninstall).toHaveBeenCalledWith('fliks.testplugin');
    expect(processService.callPlugin).not.toHaveBeenCalled();
  });

  it('PATCH /plugins/:pluginId reaches PluginsController.setEnabled, not the proxy', async () => {
    await request(app.getHttpServer()).patch('/plugins/fliks.testplugin').send({ enabled: false }).expect(200);
    expect(installService.setEnabled).toHaveBeenCalledWith('fliks.testplugin', false);
    expect(processService.callPlugin).not.toHaveBeenCalled();
  });

  it('POST /plugins/:pluginId/restart reaches PluginsController.restart, not the proxy', async () => {
    await request(app.getHttpServer()).post('/plugins/fliks.testplugin/restart').expect(204);
    expect(installService.restart).toHaveBeenCalledWith('fliks.testplugin');
    expect(processService.callPlugin).not.toHaveBeenCalled();
  });

  it('GET /plugins/:pluginId/logo reaches PluginLogoController.logo, not the proxy', async () => {
    await request(app.getHttpServer()).get('/plugins/fliks.testplugin/logo').expect(404);
    expect(registry.get).toHaveBeenCalledWith('fliks.testplugin');
    expect(processService.callPlugin).not.toHaveBeenCalled();
  });

  it('POST /plugins/import/confirm reaches PluginImportController.confirm, not the proxy', async () => {
    await request(app.getHttpServer()).post('/plugins/import/confirm').send({ pluginId: 'x', version: '1.0.0' }).expect(201);
    expect(installService.confirmImport).toHaveBeenCalledTimes(1);
    expect(processService.callPlugin).not.toHaveBeenCalled();
    expect(registry.processStateOf).not.toHaveBeenCalled();
  });

  it('GET /plugins/sources reaches PluginSourcesController.list, not the proxy', async () => {
    await request(app.getHttpServer()).get('/plugins/sources').expect(200);
    expect(sourceRepo.find).toHaveBeenCalledTimes(1);
    expect(processService.callPlugin).not.toHaveBeenCalled();
  });

  it('a genuinely undeclared plugins/* path still reaches the proxy controller', async () => {
    await request(app.getHttpServer()).get('/plugins/fliks.testplugin/some/route').expect(503);
    expect(registry.processStateOf).toHaveBeenCalledWith('fliks.testplugin');
  });

  it('GET /media/:id reaches the core stand-in controller, never the legacy-alias fallback', async () => {
    await request(app.getHttpServer()).get('/media/7').expect(200, { id: '7' });
    expect(processService.callPlugin).not.toHaveBeenCalled();
  });

  it('a URL no earlier controller claims still reaches the legacy-alias fallback', async () => {
    await request(app.getHttpServer()).get('/some/totally/unmatched/path').expect(503);
    expect(processService.callPlugin).not.toHaveBeenCalled();
    expect(registry.processStateOf).toHaveBeenCalledWith('fliks.testplugin');
  });
});
