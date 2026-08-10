import { SchedulerRegistry } from '@nestjs/schedule';
import { PluginJobsService } from './plugin-jobs.service';
import type { PluginJob } from '../../common/plugin-contract';

/** Never fires during a test run — the point of every test here is the registry entry itself. */
const FAR_FUTURE_CRON = '0 0 1 1 *';

function job(overrides: Partial<PluginJob> = {}): PluginJob {
  return { name: 'sync', cron: FAR_FUTURE_CRON, triggerable: true, labelKey: 'plugin.job.sync', ...overrides };
}

function fakeProcessService(state: 'ready' | 'crashed' | null = 'ready') {
  return {
    stateOf: jest.fn().mockReturnValue(state),
    callPlugin: jest.fn().mockResolvedValue({ ok: true }),
  };
}

// A real `CronJob` schedules a real (if far-future) `setTimeout`. Track every registry created
// by a test and clear its jobs afterwards so no test leaves a live timer behind for Jest to trip on.
const liveRegistries: SchedulerRegistry[] = [];
function trackedRegistry(): SchedulerRegistry {
  const registry = new SchedulerRegistry();
  liveRegistries.push(registry);
  return registry;
}
afterEach(() => {
  for (const registry of liveRegistries.splice(0)) {
    for (const name of registry.getCronJobs().keys()) registry.deleteCronJob(name);
  }
});

describe('PluginJobsService', () => {
  it('registers a real cron per declared job', () => {
    const registry = trackedRegistry();
    const service = new PluginJobsService(registry, fakeProcessService() as never);

    service.replaceFor('fliks.p', [job()]);

    expect(registry.doesExist('cron', 'plugin:fliks.p:sync')).toBe(true);
  });

  it('deregisters the cron when the plugin stops — proves no leaked cron outlives it', () => {
    const registry = trackedRegistry();
    const service = new PluginJobsService(registry, fakeProcessService() as never);
    service.replaceFor('fliks.p', [job()]);
    expect(registry.doesExist('cron', 'plugin:fliks.p:sync')).toBe(true);

    service.dropFor('fliks.p');

    expect(registry.doesExist('cron', 'plugin:fliks.p:sync')).toBe(false);
  });

  it('dropFor is a safe no-op for a plugin with nothing registered', () => {
    const registry = trackedRegistry();
    const service = new PluginJobsService(registry, fakeProcessService() as never);
    expect(() => service.dropFor('fliks.never-registered')).not.toThrow();
  });

  it('re-registering replaces the previous crons rather than throwing on a duplicate name', () => {
    const registry = trackedRegistry();
    const service = new PluginJobsService(registry, fakeProcessService() as never);
    service.replaceFor('fliks.p', [job({ name: 'sync' })]);

    expect(() => service.replaceFor('fliks.p', [job({ name: 'sync', cron: '0 0 2 1 *' })])).not.toThrow();
    expect(registry.doesExist('cron', 'plugin:fliks.p:sync')).toBe(true);
  });

  it('listDeclared reports every plugin currently registered', () => {
    const registry = trackedRegistry();
    const service = new PluginJobsService(registry, fakeProcessService() as never);
    service.replaceFor('fliks.a', [job({ name: 'sync' })]);
    service.replaceFor('fliks.b', [job({ name: 'sweep' })]);

    expect(service.listDeclared()).toEqual(
      expect.arrayContaining([
        { pluginId: 'fliks.a', job: job({ name: 'sync' }) },
        { pluginId: 'fliks.b', job: job({ name: 'sweep' }) },
      ]),
    );
  });

  describe('trigger', () => {
    it('refuses an unknown job name', () => {
      const registry = trackedRegistry();
      const processService = fakeProcessService();
      const service = new PluginJobsService(registry, processService as never);
      service.replaceFor('fliks.p', [job()]);

      expect(service.trigger('fliks.p', 'no-such-job')).toEqual({ ok: false, reason: 'unknown-job' });
      expect(processService.callPlugin).not.toHaveBeenCalled();
    });

    it('refuses a non-triggerable job', () => {
      const registry = trackedRegistry();
      const processService = fakeProcessService();
      const service = new PluginJobsService(registry, processService as never);
      service.replaceFor('fliks.p', [job({ triggerable: false })]);

      expect(service.trigger('fliks.p', 'sync')).toEqual({ ok: false, reason: 'not-triggerable' });
      expect(processService.callPlugin).not.toHaveBeenCalled();
    });

    it('calls the plugin over callPlugin with a deadline when ready and triggerable', () => {
      const registry = trackedRegistry();
      const processService = fakeProcessService('ready');
      const service = new PluginJobsService(registry, processService as never);
      service.replaceFor('fliks.p', [job()]);

      expect(service.trigger('fliks.p', 'sync')).toEqual({ ok: true });
      expect(processService.callPlugin).toHaveBeenCalledWith(
        'fliks.p',
        'job',
        { name: 'sync', jobId: expect.any(String) },
        expect.any(Number),
      );
    });

    it('skips a plugin that is not ready without ever calling it', () => {
      const registry = trackedRegistry();
      const processService = fakeProcessService(null);
      const service = new PluginJobsService(registry, processService as never);
      service.replaceFor('fliks.p', [job()]);

      expect(service.trigger('fliks.p', 'sync')).toEqual({ ok: true });
      expect(processService.callPlugin).not.toHaveBeenCalled();
    });
  });
});
