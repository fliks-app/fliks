import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { PluginProxyController } from './plugin-proxy.controller';
import { PluginInstallException } from '../plugin-install.exception';
import type { PluginRouteRequest } from './plugin-route.guard';

function fakeResponse(): Response & { status: jest.Mock; setHeader: jest.Mock; send: jest.Mock } {
  const res = {
    status: jest.fn(),
    setHeader: jest.fn(),
    send: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response & typeof res;
}

function fakeRequest(overrides: Partial<PluginRouteRequest> = {}): PluginRouteRequest {
  return {
    method: 'GET',
    originalUrl: '/api/plugins/fliks.testplugin/releases/42',
    params: { pluginId: 'fliks.testplugin' },
    query: {},
    body: undefined,
    user: { id: 9 },
    ...overrides,
  } as unknown as PluginRouteRequest;
}

async function captureThrown(fn: () => Promise<unknown>): Promise<PluginInstallException> {
  try {
    await fn();
  } catch (err) {
    return err as PluginInstallException;
  }
  throw new Error('expected proxy() to throw');
}

function makeController(state: string | null, callPlugin: jest.Mock) {
  const registry = {
    processStateOf: jest.fn().mockReturnValue(state),
    processStatusMessageOf: jest.fn().mockReturnValue('crashed hard'),
  };
  const processService = { callPlugin };
  const controller = new PluginProxyController(registry as never, processService as never);
  return { controller, registry, processService };
}

describe('PluginProxyController — plugin availability', () => {
  it.each([
    ['unregistered', null],
    ['crashed', 'crashed'],
    ['backoff', 'backoff'],
  ])('503 PLUGIN_UNAVAILABLE when the supervisor state is %s', async (_label, state) => {
    const callPlugin = jest.fn();
    const { controller } = makeController(state, callPlugin);
    const req = fakeRequest();
    const res = fakeResponse();

    const err = await captureThrown(() => controller.proxy('fliks.testplugin', req, res));
    expect(callPlugin).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(PluginInstallException);
    expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(err.code).toBe('PLUGIN_UNAVAILABLE');
    expect(err.message).toContain('fliks.testplugin');
  });

  it('503 PLUGIN_UNAVAILABLE when the RPC call itself rejects (e.g. a hung plugin past the deadline)', async () => {
    const callPlugin = jest.fn().mockRejectedValue(new Error('timeout waiting for "http"'));
    const { controller } = makeController('ready', callPlugin);
    const req = fakeRequest();
    const res = fakeResponse();

    const err = await captureThrown(() => controller.proxy('fliks.testplugin', req, res));
    expect(err).toBeInstanceOf(PluginInstallException);
    expect(err.code).toBe('PLUGIN_UNAVAILABLE');
    expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('forwards the request\'s own path (not the declared pattern), method, query, body and delegated principal', async () => {
    const callPlugin = jest.fn().mockResolvedValue({ status: 200, headers: {}, body: { ok: true } });
    const { controller, processService } = makeController('ready', callPlugin);
    const req = fakeRequest({
      method: 'POST',
      originalUrl: '/api/plugins/fliks.testplugin/releases/42?x=1',
      query: { x: '1' },
      body: { grab: true },
      user: { id: 9 } as never,
    });
    const res = fakeResponse();

    await controller.proxy('fliks.testplugin', req, res);

    expect(processService.callPlugin).toHaveBeenCalledWith(
      'fliks.testplugin',
      'http',
      {
        method: 'POST',
        path: '/releases/42',
        query: { x: '1' },
        body: { grab: true },
        principal: { kind: 'delegated', userId: 9 },
      },
      30_000,
    );
  });
});

describe('PluginProxyController — status clamping', () => {
  it.each([
    [200, 200],
    [404, 404],
    [100, 100],
    [599, 599],
    [0, HttpStatus.BAD_GATEWAY],
    [99, HttpStatus.BAD_GATEWAY],
    [600, HttpStatus.BAD_GATEWAY],
    [1000, HttpStatus.BAD_GATEWAY],
    [-1, HttpStatus.BAD_GATEWAY],
    [200.5, HttpStatus.BAD_GATEWAY],
    [NaN, HttpStatus.BAD_GATEWAY],
    [undefined, HttpStatus.BAD_GATEWAY],
    ['200', HttpStatus.BAD_GATEWAY],
  ])('plugin status %j -> %d', async (pluginStatus, expected) => {
    const callPlugin = jest.fn().mockResolvedValue({ status: pluginStatus, headers: {}, body: {} });
    const { controller } = makeController('ready', callPlugin);
    const res = fakeResponse();

    await controller.proxy('fliks.testplugin', fakeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(expected);
  });
});

describe('PluginProxyController — response header allowlist', () => {
  it('keeps only the allowed headers and drops everything else, including session/navigation-steering ones', async () => {
    const callPlugin = jest.fn().mockResolvedValue({
      status: 200,
      headers: {
        'Set-Cookie': 'session=hijacked',
        Location: 'https://evil.example.com',
        Authorization: 'Bearer stolen',
        'x-frame-options': 'DENY',
        'Content-Type': 'application/json',
      },
      body: {},
    });
    const { controller } = makeController('ready', callPlugin);
    const res = fakeResponse();

    await controller.proxy('fliks.testplugin', fakeRequest(), res);

    const setHeaderNames = res.setHeader.mock.calls.map(([name]: [string]) => name);
    expect(setHeaderNames).toEqual(['Content-Type']);
  });

  it('drops a header name containing CRLF even if its lowercase form would otherwise be allowed', async () => {
    const callPlugin = jest.fn().mockResolvedValue({
      status: 200,
      headers: { 'content-type\r\nX-Injected': 'evil' },
      body: {},
    });
    const { controller } = makeController('ready', callPlugin);
    const res = fakeResponse();

    await controller.proxy('fliks.testplugin', fakeRequest(), res);

    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('drops an allowlisted header whose value carries CRLF, which Node would throw on', async () => {
    const callPlugin = jest.fn().mockResolvedValue({
      status: 200,
      headers: {
        'content-disposition': 'attachment\r\nX-Smuggled: yes',
        'content-type': 'text/plain',
      },
      body: {},
    });
    const { controller } = makeController('ready', callPlugin);
    const res = fakeResponse();

    await controller.proxy('fliks.testplugin', fakeRequest(), res);

    const names = res.setHeader.mock.calls.map(([name]: [string]) => name.toLowerCase());
    expect(names).toEqual(['content-type']);
  });

  it('keeps every header on the allowlist', async () => {
    const callPlugin = jest.fn().mockResolvedValue({
      status: 200,
      headers: {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="x.txt"',
        'cache-control': 'no-store',
        etag: '"abc"',
        'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
      },
      body: 'x',
    });
    const { controller } = makeController('ready', callPlugin);
    const res = fakeResponse();

    await controller.proxy('fliks.testplugin', fakeRequest(), res);

    expect(res.setHeader).toHaveBeenCalledTimes(5);
  });
});
