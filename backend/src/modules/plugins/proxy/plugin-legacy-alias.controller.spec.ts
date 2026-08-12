import type { Response } from 'express';
import { PluginLegacyAliasController } from './plugin-legacy-alias.controller';
import {
  RESOLVED_LEGACY_ALIAS_KEY,
  type PluginLegacyAliasRequest,
} from './plugin-legacy-alias.guard';

function fakeResponse(): Response & {
  status: jest.Mock;
  setHeader: jest.Mock;
  send: jest.Mock;
} {
  const res = { status: jest.fn(), setHeader: jest.fn(), send: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & typeof res;
}

describe('PluginLegacyAliasController', () => {
  it("forwards to the guard-resolved plugin id and target path, not the request's own URL", async () => {
    const callPlugin = jest
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, body: { ok: true } });
    const registry = {
      processStateOf: jest.fn().mockReturnValue('ready'),
      processStatusMessageOf: jest.fn().mockReturnValue(''),
    };
    const processService = { callPlugin };
    const controller = new PluginLegacyAliasController(
      registry as never,
      processService as never,
    );

    const req = {
      method: 'GET',
      originalUrl: '/api/media/7/releases',
      query: {},
      body: undefined,
      user: { id: 9 },
      [RESOLVED_LEGACY_ALIAS_KEY]: {
        pluginId: 'fliks.testplugin',
        targetPath: '/7/releases',
      },
    } as unknown as PluginLegacyAliasRequest;
    const res = fakeResponse();

    await controller.handle(req, res);

    expect(callPlugin).toHaveBeenCalledWith(
      'fliks.testplugin',
      'http',
      expect.objectContaining({
        method: 'GET',
        path: '/7/releases',
        principal: { kind: 'delegated', userId: 9 },
      }),
      30_000,
    );
  });
});
