import { PluginBackupController } from './plugin-backup.controller';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CHECK_POLICIES_KEY, type PolicyHandler } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import type { AppAbility } from '../auth/casl/casl-ability.factory';

/** An ability that answers false to everything: a route's declared policy must refuse it. */
function denyAll(): AppAbility {
  return { can: () => false } as unknown as AppAbility;
}

function allowOnly(action: Action, subject: string): AppAbility {
  return { can: (a: Action, s: string) => a === action && s === subject } as unknown as AppAbility;
}

function policiesFor(method: 'export' | 'import'): PolicyHandler[] {
  return (Reflect.getMetadata(CHECK_POLICIES_KEY, PluginBackupController.prototype[method]) ??
    []) as PolicyHandler[];
}

describe('PluginBackupController — authorization', () => {
  it('puts both routes behind the authenticated policies guard', () => {
    // An export is a credential dump; losing this guard is the one defect worth a test here.
    const guards = (Reflect.getMetadata('__guards__', PluginBackupController) ?? []) as unknown[];
    expect(guards).toContain(JwtOrApiKeyGuard);
    expect(guards).toContain(PoliciesGuard);
  });

  it.each([
    ['export' as const, Action.Read],
    ['import' as const, Action.Manage],
  ])('declares a %s policy that refuses an ability without it', (method, needed) => {
    const handlers = policiesFor(method);
    expect(handlers.length).toBeGreaterThan(0);

    const asCallback = handlers[0] as (ability: AppAbility) => boolean;
    expect(asCallback(denyAll())).toBe(false);
    expect(asCallback(allowOnly(needed, 'Settings'))).toBe(true);
  });
});

describe('PluginBackupController', () => {
  it('delegates export to the backup service', async () => {
    const doc = { pluginId: 'acme.tool' };
    const backup = { exportPlugin: jest.fn(async () => doc) };
    const controller = new PluginBackupController(backup as never);

    await expect(controller.export('acme.tool')).resolves.toBe(doc);
    expect(backup.exportPlugin).toHaveBeenCalledWith('acme.tool');
  });

  it('delegates import to the backup service, forwarding the raw body', async () => {
    const result = { pluginId: 'acme.tool', tablesRestored: {}, settingsRestored: 0 };
    const backup = { importPlugin: jest.fn(async () => result) };
    const controller = new PluginBackupController(backup as never);
    const body = { formatVersion: 1 };

    await expect(controller.import('acme.tool', body)).resolves.toBe(result);
    expect(backup.importPlugin).toHaveBeenCalledWith('acme.tool', body);
  });
});
