import { PluginRegistration } from './entities/plugin-registration.entity';
import type { PluginProcessStartResult } from './plugin-process.service';

/** Not a `.spec.ts` — shared fakes for `PluginRegistryService`'s two new constructor dependencies. */

export function fakeRegistrationRepo(): {
  rows: Map<string, PluginRegistration>;
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  delete: jest.Mock;
} {
  const rows = new Map<string, PluginRegistration>();
  let nextId = 1;
  return {
    rows,
    findOne: jest.fn(async ({ where: { pluginId } }: { where: { pluginId: string } }) => rows.get(pluginId) ?? null),
    create: jest.fn(
      (partial: Partial<PluginRegistration>) =>
        ({ id: nextId++, createdAt: new Date(), updatedAt: new Date(), ...partial }) as PluginRegistration,
    ),
    save: jest.fn(async (row: PluginRegistration) => {
      rows.set(row.pluginId, row);
      return row;
    }),
    delete: jest.fn(async ({ pluginId }: { pluginId: string }) => {
      const existed = rows.delete(pluginId);
      return { affected: existed ? 1 : 0 };
    }),
  };
}

export function fakeProcessService(startForResult: PluginProcessStartResult = { ok: true }): {
  startFor: jest.Mock;
  stopFor: jest.Mock;
  stateOf: jest.Mock;
  statusMessageOf: jest.Mock;
  restart: jest.Mock;
  stopAll: jest.Mock;
  emitToAll: jest.Mock;
} {
  return {
    startFor: jest.fn(async () => startForResult),
    stopFor: jest.fn(async () => undefined),
    stateOf: jest.fn(() => null),
    statusMessageOf: jest.fn(() => ''),
    restart: jest.fn(async () => startForResult),
    stopAll: jest.fn(async () => undefined),
    emitToAll: jest.fn(),
  };
}

/** A no-op stand-in for `PluginJobsService` — tests that care about cron lifecycle construct
 *  a real one (see `plugin-registry.service.jobs.spec.ts`) instead of using this. */
export function fakePluginJobsService(): {
  replaceFor: jest.Mock;
  dropFor: jest.Mock;
  listDeclared: jest.Mock;
  declaredJob: jest.Mock;
  trigger: jest.Mock;
} {
  return {
    replaceFor: jest.fn(),
    dropFor: jest.fn(),
    listDeclared: jest.fn(() => []),
    declaredJob: jest.fn(() => undefined),
    trigger: jest.fn(() => ({ ok: true })),
  };
}

/** Stands in for `ScheduledJobRegistry` — `names` seeds what a registry publisher
 *  (e.g. an installed plugin) already holds, for the job-name-collision check. */
export function fakeScheduledJobRegistry(names: readonly string[] = []): { list: jest.Mock } {
  return {
    list: jest.fn(() => names.map((name) => ({ name, cron: '* * * * *', triggerable: true, run: jest.fn() }))),
  };
}

export function fakeCountsCache(): { forget: jest.Mock } {
  return { forget: jest.fn() };
}
