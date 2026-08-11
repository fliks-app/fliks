import { SchedulerRegistry } from '@nestjs/schedule';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginJobsService } from './plugin-jobs.service';
import { PluginPackage } from './entities/plugin-package.entity';
import { minimalProcessManifest } from './archive/test-manifests';
import { fakeRegistrationRepo, fakeProcessService, fakeScheduledJobRegistry } from './plugin-registry.test-helpers';
import { CORE_SCHEDULER_JOB_NAMES } from '../../common/constants/core-scheduler-jobs';
import type { PluginJob, PluginManifest } from '../../common/plugin-contract';
import type { PluginProcessStartResult } from './plugin-process.service';

/** A `fliks` range every test can rely on matching this repo's own `package.json` version. */
const COMPATIBLE_RANGE = '>=1.0.0 <3.0.0';
/** Never fires during a test run — the point of every test here is the registry entry itself. */
const FAR_FUTURE_CRON = '0 0 1 1 *';

function makePackage(manifest: PluginManifest, overrides: Partial<PluginPackage> = {}): PluginPackage {
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
    ...overrides,
  } as PluginPackage;
}

function job(overrides: Partial<PluginJob> = {}): PluginJob {
  return { name: 'sync', cron: FAR_FUTURE_CRON, triggerable: true, labelKey: 'plugin.job.sync', ...overrides };
}

function processManifest(pluginId: string, jobs: unknown[]): PluginManifest {
  return {
    ...minimalProcessManifest({ 'plugin.js': 'a'.repeat(64), 'logo.png': 'b'.repeat(64) }, {
      id: pluginId,
      fliks: COMPATIBLE_RANGE,
    }),
    jobs,
  } as unknown as PluginManifest;
}

// A real `CronJob` schedules a real (if far-future) `setTimeout`. Track every registry created
// by a test and clear its jobs afterwards so no test leaves a live timer behind for Jest to trip on.
const liveRegistries: SchedulerRegistry[] = [];
afterEach(() => {
  for (const registry of liveRegistries.splice(0)) {
    for (const name of registry.getCronJobs().keys()) registry.deleteCronJob(name);
  }
});

/** Real `SchedulerRegistry` + real `PluginJobsService` — only `PluginProcessService` is faked —
 *  so "a cron is deregistered" is proven against the actual registry, not a mock of it. */
function makeService(startResult?: PluginProcessStartResult, publishedJobNames: readonly string[] = []) {
  const registry = new SchedulerRegistry();
  liveRegistries.push(registry);
  const processService = fakeProcessService(startResult);
  const pluginJobs = new PluginJobsService(registry, processService as never);
  const scheduledJobs = fakeScheduledJobRegistry(publishedJobNames);
  const service = new PluginRegistryService(
    { find: jest.fn().mockResolvedValue([]) } as never,
    fakeRegistrationRepo() as never,
    processService as never,
    pluginJobs,
    scheduledJobs as never,
  );
  return { service, registry, pluginJobs };
}

describe('PluginRegistryService — jobs registration', () => {
  it('refuses an empty job name', async () => {
    const manifest = processManifest('fliks.jobtest', [job({ name: '' })]);
    const { service } = makeService();
    const result = await service.register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: 'fliks.jobtest', reason: 'invalid-job-name', detail: expect.any(String) });
  });

  it('refuses a duplicate job name within the same plugin', async () => {
    const manifest = processManifest('fliks.jobtest', [job({ name: 'sync' }), job({ name: 'sync' })]);
    const { service } = makeService();
    const result = await service.register(makePackage(manifest));
    expect(result).toEqual({
      ok: false,
      pluginId: 'fliks.jobtest',
      reason: 'invalid-job-name',
      detail: expect.stringContaining('duplicate'),
    });
  });

  it.each(CORE_SCHEDULER_JOB_NAMES)('refuses a job name that shadows the core job "%s"', async (coreName) => {
    const manifest = processManifest('fliks.jobtest', [job({ name: coreName })]);
    const { service } = makeService();
    const result = await service.register(makePackage(manifest));
    expect(result).toEqual({
      ok: false,
      pluginId: 'fliks.jobtest',
      reason: 'job-name-conflict',
      detail: expect.stringContaining(coreName),
    });
  });

  it('refuses a job name already published by a ScheduledJobRegistry publisher (e.g. the download bundle)', async () => {
    const manifest = processManifest('fliks.jobtest', [job({ name: 'SearchMissing' })]);
    const { service } = makeService(undefined, ['SearchMissing']);
    const result = await service.register(makePackage(manifest));
    expect(result).toEqual({
      ok: false,
      pluginId: 'fliks.jobtest',
      reason: 'job-name-conflict',
      detail: expect.stringContaining('SearchMissing'),
    });
  });

  it('refuses a cron expression the scheduler cannot parse', async () => {
    const manifest = processManifest('fliks.jobtest', [job({ cron: 'not-a-cron' })]);
    const { service } = makeService();
    const result = await service.register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: 'fliks.jobtest', reason: 'invalid-job-cron', detail: expect.any(String) });
  });

  it('refuses a non-boolean triggerable', async () => {
    const manifest = processManifest('fliks.jobtest', [{ ...job(), triggerable: 'yes' }]);
    const { service } = makeService();
    const result = await service.register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: 'fliks.jobtest', reason: 'invalid-job-triggerable', detail: expect.any(String) });
  });

  it('refuses an empty labelKey', async () => {
    const manifest = processManifest('fliks.jobtest', [job({ labelKey: '' })]);
    const { service } = makeService();
    const result = await service.register(makePackage(manifest));
    expect(result).toEqual({ ok: false, pluginId: 'fliks.jobtest', reason: 'invalid-job-label', detail: expect.any(String) });
  });

  it('registers a real cron once the plugin activates', async () => {
    const manifest = processManifest('fliks.jobtest', [job()]);
    const { service, registry } = makeService();

    const result = await service.register(makePackage(manifest));

    expect(result).toEqual({ ok: true, pluginId: 'fliks.jobtest' });
    expect(registry.doesExist('cron', 'plugin:fliks.jobtest:sync')).toBe(true);
  });

  it('never registers a cron when activation fails — no leaked cron for a plugin that never ran', async () => {
    const manifest = processManifest('fliks.jobtest', [job()]);
    const { service, registry } = makeService({ ok: false, reason: 'spawn-failed', detail: 'boom' });

    const result = await service.register(makePackage(manifest));

    expect(result).toMatchObject({ ok: false, reason: 'spawn-failed' });
    expect(registry.doesExist('cron', 'plugin:fliks.jobtest:sync')).toBe(false);
  });

  it('deregisters the cron on unregister — proves no leaked cron outlives the plugin', async () => {
    const manifest = processManifest('fliks.jobtest', [job()]);
    const { service, registry } = makeService();
    await service.register(makePackage(manifest));
    expect(registry.doesExist('cron', 'plugin:fliks.jobtest:sync')).toBe(true);

    await service.unregister('fliks.jobtest');

    expect(registry.doesExist('cron', 'plugin:fliks.jobtest:sync')).toBe(false);
  });

  it('deregisters the cron on forget (uninstall)', async () => {
    const manifest = processManifest('fliks.jobtest', [job()]);
    const { service, registry } = makeService();
    await service.register(makePackage(manifest));

    await service.forget('fliks.jobtest');

    expect(registry.doesExist('cron', 'plugin:fliks.jobtest:sync')).toBe(false);
  });

  it('exposes the declared job on the shared listing surface', async () => {
    const manifest = processManifest('fliks.jobtest', [job()]);
    const { service, pluginJobs } = makeService();
    await service.register(makePackage(manifest));

    expect(pluginJobs.listDeclared()).toEqual([{ pluginId: 'fliks.jobtest', job: job() }]);
  });
});
