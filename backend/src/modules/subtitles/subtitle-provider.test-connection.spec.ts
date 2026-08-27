import { SubtitleProviderService } from './subtitle-provider.service';
import { testResultFromResponse } from './providers/subtitle-provider.interface';

function serviceWith(testConnection: () => Promise<unknown>) {
  const factory = { create: () => ({ testConnection }) };
  return new SubtitleProviderService({} as never, factory as never);
}

function response(init: {
  ok: boolean;
  status: number;
  statusText?: string;
  body?: unknown;
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    statusText: init.statusText ?? '',
    json: () =>
      init.body === undefined
        ? Promise.reject(new SyntaxError('Unexpected token < in JSON'))
        : Promise.resolve(init.body),
  } as unknown as Response;
}

describe('testResultFromResponse', () => {
  it("prefers the provider's own reason over the bare status", async () => {
    const res = response({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      body: { message: 'Error, invalid username/password  ', status: 401 },
    });

    await expect(testResultFromResponse(res)).resolves.toEqual({
      ok: false,
      detail: 'HTTP 401: Error, invalid username/password',
    });
  });

  it('falls back to the status when the body is an HTML error page', async () => {
    await expect(
      testResultFromResponse(
        response({ ok: false, status: 503, statusText: 'Service Unavailable' }),
      ),
    ).resolves.toEqual({ ok: false, detail: 'HTTP 503 Service Unavailable' });
  });

  it('ignores a JSON body that carries no reason', async () => {
    await expect(
      testResultFromResponse(
        response({ ok: false, status: 500, body: { code: 12 } }),
      ),
    ).resolves.toEqual({ ok: false, detail: 'HTTP 500' });
  });

  it('carries no detail on success', async () => {
    await expect(
      testResultFromResponse(
        response({ ok: true, status: 200, statusText: 'OK' }),
      ),
    ).resolves.toEqual({ ok: true });
  });
});

describe('SubtitleProviderService.testConnection', () => {
  it('turns a thrown network failure into a verdict instead of a 500', async () => {
    const service = serviceWith(() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND api.example.com')),
    );

    await expect(
      service.testConnection('opensubtitles' as never, {}),
    ).resolves.toEqual({
      ok: false,
      detail: 'getaddrinfo ENOTFOUND api.example.com',
    });
  });

  it('passes the provider verdict through untouched', async () => {
    const service = serviceWith(() =>
      Promise.resolve({ ok: false, detail: 'missing username or password' }),
    );

    await expect(
      service.testConnection('opensubtitles' as never, {}),
    ).resolves.toEqual({
      ok: false,
      detail: 'missing username or password',
    });
  });
});
