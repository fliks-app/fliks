import { PluginRegistration } from './entities/plugin-registration.entity';
import type { PluginProcessStartResult } from './plugin-process.service';

/** Not a `.spec.ts` — shared fakes for `PluginRegistryService`'s two new constructor dependencies. */

export function fakeRegistrationRepo(): {
  rows: Map<string, PluginRegistration>;
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
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
    restart: jest.fn(async () => undefined),
    stopAll: jest.fn(async () => undefined),
    emitToAll: jest.fn(),
  };
}
