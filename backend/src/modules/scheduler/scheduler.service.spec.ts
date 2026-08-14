import { BadRequestException } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { PluginJobsService } from '../plugins/plugin-jobs.service';
import { ScheduledJobRegistry } from './scheduled-job-registry.service';

function fakePluginJobs(overrides: Partial<Record<'listDeclared' | 'trigger', jest.Mock>> = {}) {
  return {
    listDeclared: jest.fn().mockReturnValue([]),
    trigger: jest.fn(),
    ...overrides,
  };
}

/** Only `commandRepo`+`pluginJobs`+`jobRegistry` are ever touched by `triggerCommand`'s
 *  unknown-name and plugin-job branches — every other dependency stays an unused stub. */
function makeService(pluginJobs: ReturnType<typeof fakePluginJobs>, jobRegistry: { list: jest.Mock } = { list: jest.fn().mockReturnValue([]) }) {
  const unused = {} as never;
  return new SchedulerService(
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    pluginJobs as unknown as PluginJobsService,
    jobRegistry as unknown as ScheduledJobRegistry,
  );
}

describe('SchedulerService.triggerCommand', () => {
  it('routes a declared plugin job name through PluginJobsService.trigger()', async () => {
    const pluginJobs = fakePluginJobs({
      listDeclared: jest.fn().mockReturnValue([
        { pluginId: 'fliks.p', job: { name: 'sync', cron: '0 0 * * *', triggerable: true, labelKey: 'k' } },
      ]),
      trigger: jest.fn().mockReturnValue({ ok: true }),
    });
    const service = makeService(pluginJobs);

    const result = await service.triggerCommand('sync');

    expect(pluginJobs.trigger).toHaveBeenCalledWith('fliks.p', 'sync');
    expect(result).toEqual({ ok: true });
  });

  it('400s a declared-but-not-triggerable plugin job instead of dispatching it', async () => {
    const pluginJobs = fakePluginJobs({
      listDeclared: jest.fn().mockReturnValue([
        { pluginId: 'fliks.p', job: { name: 'sync', cron: '0 0 * * *', triggerable: false, labelKey: 'k' } },
      ]),
      trigger: jest.fn().mockReturnValue({ ok: false, reason: 'not-triggerable' }),
    });
    const service = makeService(pluginJobs);

    await expect(service.triggerCommand('sync')).rejects.toThrow(/not triggerable/);
    expect(pluginJobs.trigger).toHaveBeenCalledWith('fliks.p', 'sync');
  });

  it('still 400s a name that is neither a core command nor a declared plugin job', async () => {
    const pluginJobs = fakePluginJobs();
    const service = makeService(pluginJobs);

    await expect(service.triggerCommand('NoSuchJob')).rejects.toThrow(BadRequestException);
    expect(pluginJobs.trigger).not.toHaveBeenCalled();
  });
});
