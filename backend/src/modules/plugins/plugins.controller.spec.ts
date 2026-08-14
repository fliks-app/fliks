import { PluginsController } from './plugins.controller';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CHECK_POLICIES_KEY, type PolicyHandler } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import type { AppAbility } from '../auth/casl/casl-ability.factory';

const noProcessService = { metricsOf: jest.fn() };

/** An ability that answers false to everything: a route's declared policy must refuse it. */
function denyAll(): AppAbility {
  return { can: () => false } as unknown as AppAbility;
}

function allowOnly(action: Action, subject: string): AppAbility {
  return { can: (a: Action, s: string) => a === action && s === subject } as unknown as AppAbility;
}

function policiesFor(method: 'list' | 'metrics'): PolicyHandler[] {
  return (Reflect.getMetadata(CHECK_POLICIES_KEY, PluginsController.prototype[method]) ?? []) as PolicyHandler[];
}

describe('PluginsController', () => {
  it('delegates uninstall to the install service', async () => {
    const installService = { uninstall: jest.fn().mockResolvedValue(undefined) };
    const controller = new PluginsController(installService as never, { sendTest: jest.fn() } as never, noProcessService as never);

    await expect(controller.uninstall('fliks.test-plugin')).resolves.toBeUndefined();
    expect(installService.uninstall).toHaveBeenCalledWith('fliks.test-plugin');
  });

  it('delegates list to the install service', async () => {
    const rows = [{ pluginId: 'fliks.test-plugin', status: 'active' }];
    const installService = { listInstalled: jest.fn().mockResolvedValue(rows) };
    const controller = new PluginsController(installService as never, { sendTest: jest.fn() } as never, noProcessService as never);

    await expect(controller.list()).resolves.toBe(rows);
    expect(installService.listInstalled).toHaveBeenCalled();
  });


  it('delegates restart to the install service', async () => {
    const installService = { restart: jest.fn().mockResolvedValue(undefined) };
    const controller = new PluginsController(installService as never, { sendTest: jest.fn() } as never, noProcessService as never);

    await expect(controller.restart('fliks.test-plugin')).resolves.toBeUndefined();
    expect(installService.restart).toHaveBeenCalledWith('fliks.test-plugin');
  });

  it('delegates disable to the install service', async () => {
    const summary = { pluginId: 'fliks.test-plugin', enabled: false };
    const installService = { disable: jest.fn().mockResolvedValue(summary) };
    const controller = new PluginsController(installService as never, { sendTest: jest.fn() } as never, noProcessService as never);

    await expect(controller.disable('fliks.test-plugin')).resolves.toBe(summary);
    expect(installService.disable).toHaveBeenCalledWith('fliks.test-plugin');
  });

  it('delegates enable to the install service', async () => {
    const summary = { pluginId: 'fliks.test-plugin', enabled: true };
    const installService = { enable: jest.fn().mockResolvedValue(summary) };
    const controller = new PluginsController(installService as never, { sendTest: jest.fn() } as never, noProcessService as never);

    await expect(controller.enable('fliks.test-plugin')).resolves.toBe(summary);
    expect(installService.enable).toHaveBeenCalledWith('fliks.test-plugin');
  });

  describe('metrics', () => {
    it('pairs each installed plugin with its process metrics, and null for a data plugin', async () => {
      const rows = [
        { pluginId: 'fliks.download', kind: 'process' },
        { pluginId: 'fliks.notify', kind: 'data' },
      ];
      const installService = { listInstalled: jest.fn().mockResolvedValue(rows) };
      const processMetrics = { hostCallCount: 3, hostCallFailureCount: 0, hostCallP95Ms: 12, restartCount: 0, eventDropCount: 0, residentSetSizeBytes: 123 };
      const processService = { metricsOf: jest.fn().mockReturnValue(processMetrics) };
      const controller = new PluginsController(installService as never, { sendTest: jest.fn() } as never, processService as never);

      const result = await controller.metrics();

      expect(result).toEqual([
        { pluginId: 'fliks.download', kind: 'process', metrics: processMetrics },
        { pluginId: 'fliks.notify', kind: 'data', metrics: null },
      ]);
      expect(processService.metricsOf).toHaveBeenCalledWith('fliks.download');
      expect(processService.metricsOf).not.toHaveBeenCalledWith('fliks.notify');
    });
  });

  describe('authorization', () => {
    it('puts the controller behind the authenticated policies guard', () => {
      const guards = (Reflect.getMetadata('__guards__', PluginsController) ?? []) as unknown[];
      expect(guards).toContain(JwtOrApiKeyGuard);
      expect(guards).toContain(PoliciesGuard);
    });

    it.each([['list' as const], ['metrics' as const]])(
      'declares a Settings-read policy on %s that refuses an ability without it',
      (method) => {
        const handlers = policiesFor(method);
        expect(handlers.length).toBeGreaterThan(0);

        const asCallback = handlers[0] as (ability: AppAbility) => boolean;
        expect(asCallback(denyAll())).toBe(false);
        expect(asCallback(allowOnly(Action.Read, 'Settings'))).toBe(true);
      },
    );
  });
});
