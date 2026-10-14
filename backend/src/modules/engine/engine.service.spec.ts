import {
  EngineService,
  hostUrl,
  MIN_ENGINE_PROTOCOL,
  toEngineStreaming,
  type EngineClient,
} from './engine.service';
import type { StreamingSettings } from '../streaming/streaming-settings-cache.service';

const HELLO = {
  engineVersion: '0.2.0',
  protocolVersion: MIN_ENGINE_PROTOCOL,
  features: ['probe', 'capabilities', 'decide'],
  instanceId: 'x',
};

function mockClient(over: Record<string, jest.Mock> = {}) {
  const client = {
    GET: jest.fn(async (url: string) =>
      url === '/v1/hello'
        ? { data: HELLO, response: { status: 200 } }
        : { data: { revision: 7 }, response: { status: 200 } },
    ),
    PUT: jest.fn(async () => ({ response: { ok: true, status: 200 } })),
    POST: jest.fn(),
    ...over,
  };
  return client as typeof client & EngineClient;
}

function svc(): EngineService {
  const s = new EngineService();
  (s as any).sleep = async () => undefined;
  return s;
}

const settings: StreamingSettings = {
  segmentDuration: 3,
  qsvPreset: 'faster',
  tonemapAlgo: 'auto',
  tonemapCurve: 'mobius',
  cacheMaxBytes: 20 * 1024 ** 3,
  cacheTtlMs: 4 * 3_600_000,
  ffmpegSlots: null,
  autoQualityMode: 'directplay',
  autoCropEnabled: true,
  gpuRenderNode: '/dev/dri/renderD129',
  subtitlePrewarm: 'playback',
  throttleEnabled: true,
  throttleThresholdSeconds: 90,
};

describe('EngineService hello gating', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('is disabled without both env vars', async () => {
    delete process.env.FLIKS_ENGINE_URL;
    process.env.FLIKS_ENGINE_TOKEN = 't';
    const s = svc();
    await s.whenReady();
    expect(s.enabled).toBe(false);
  });

  it('enables on a compatible engine', async () => {
    const s = svc();
    await s.connect(mockClient());
    expect(s.enabled).toBe(true);
  });

  it('refuses a protocol below the minimum', async () => {
    const s = svc();
    const c = mockClient({
      GET: jest.fn(async () => ({ data: { ...HELLO, protocolVersion: 0 } })),
    });
    await s.connect(c);
    expect(s.enabled).toBe(false);
  });

  it.each(['probe', 'capabilities'])(
    'refuses an engine without the %s feature',
    async (f) => {
      const s = svc();
      const c = mockClient({
        GET: jest.fn(async () => ({
          data: { ...HELLO, features: HELLO.features.filter((x) => x !== f) },
        })),
      });
      await s.connect(c);
      expect(s.enabled).toBe(false);
    },
  );

  it('retries while the engine starts', async () => {
    const s = svc();
    const get = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ response: { status: 503 } })
      .mockResolvedValue({ data: HELLO, response: { status: 200 } });
    await s.connect(mockClient({ GET: get }));
    expect(s.enabled).toBe(true);
    expect(get.mock.calls.filter(([u]) => u === '/v1/hello')).toHaveLength(3);
  });

  it('stays disabled when the engine never answers', async () => {
    const s = svc();
    await s.connect(
      mockClient({ GET: jest.fn().mockRejectedValue(new Error('down')) }),
    );
    expect(s.enabled).toBe(false);
  });
});

describe('EngineService background connection', () => {
  const tick = (s: EngineService) => (s as any).tick();
  afterEach(() => jest.clearAllTimers());

  it('keeps retrying after the boot window and notifies once the engine answers', async () => {
    const s = svc();
    const get = jest
      .fn()
      .mockRejectedValue(new Error('down'))
      .mockImplementation(async (u: string) =>
        u === '/v1/hello'
          ? Promise.reject(new Error('down'))
          : { data: { revision: 4 } },
      );
    const c = mockClient({ GET: get });
    const onConnect = jest.fn();
    s.onConnect(onConnect);
    await s.connect(c);
    expect(s.enabled).toBe(false);

    await tick(s);
    expect(s.enabled).toBe(false);
    expect(onConnect).not.toHaveBeenCalled();

    get.mockImplementation(async (u: string) =>
      u === '/v1/hello' ? { data: HELLO } : { data: { revision: 4 } },
    );
    await tick(s);
    expect(s.enabled).toBe(true);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('reloads on an instanceId change and keeps its state while hello fails', async () => {
    const s = svc();
    const c = mockClient();
    const onConnect = jest.fn();
    s.onConnect(onConnect);
    await s.connect(c);
    await s.pushStreaming(toEngineStreaming(settings));

    await tick(s);
    expect(onConnect).not.toHaveBeenCalled();

    c.GET.mockRejectedValue(new Error('down'));
    await tick(s);
    expect(s.enabled).toBe(true);
    expect(onConnect).not.toHaveBeenCalled();

    c.GET.mockImplementation(async (u: string) =>
      u === '/v1/hello'
        ? { data: { ...HELLO, instanceId: 'y' }, response: { status: 200 } }
        : { data: { revision: 0 }, response: { status: 200 } },
    );
    await tick(s);
    expect(onConnect).toHaveBeenCalledTimes(1);
    await s.pushStreaming(toEngineStreaming(settings));
    expect(c.PUT).toHaveBeenCalledTimes(2);
    expect((c.PUT.mock.calls[1] as any)[1].body.revision).toBe(1);
  });
});

describe('EngineService config push', () => {
  it('maps the streaming settings onto EngineConfig.streaming', () => {
    expect(toEngineStreaming(settings)).toEqual(settings);
    expect(toEngineStreaming({ ...settings, ffmpegSlots: 3 }).ffmpegSlots).toBe(
      3,
    );
  });

  it('continues the engine revision and skips an unchanged push', async () => {
    const s = svc();
    const c = mockClient();
    await s.connect(c);
    await s.pushStreaming(toEngineStreaming(settings));
    await s.pushStreaming(toEngineStreaming(settings));
    await s.pushStreaming(
      toEngineStreaming({ ...settings, gpuRenderNode: 'auto' }),
    );

    expect(c.PUT).toHaveBeenCalledTimes(2);
    expect(c.PUT).toHaveBeenNthCalledWith(1, '/v1/config', {
      body: {
        revision: 8,
        hostUrl: hostUrl(),
        hostToken: s.hostToken,
        streaming: toEngineStreaming(settings),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        lifetime: expect.objectContaining({
          jobGraceMs: 60_000,
          maxSessionsPerOwner: 10,
        }),
      },
    });
    expect((c.PUT.mock.calls[1] as any)[1].body.revision).toBe(9);
  });

  it('does not count a rejected push', async () => {
    const s = svc();
    const c = mockClient({
      PUT: jest.fn(async () => ({ response: { ok: false, status: 409 } })),
    });
    await s.connect(c);
    await expect(s.pushStreaming(toEngineStreaming(settings))).rejects.toThrow(
      '409',
    );
    await expect(s.pushStreaming(toEngineStreaming(settings))).rejects.toThrow(
      '409',
    );
    expect((c.PUT.mock.calls[1] as any)[1].body.revision).toBe(8);
  });
});

describe('EngineService capabilities', () => {
  const caps = (node: string | null) => ({
    hwAccel: 'vaapi',
    gpus: node ? [{ renderNode: node, name: 'g' }] : [],
    defaultGpu: node,
  });

  it('waits out 503 + Retry-After', async () => {
    const s = svc();
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: HELLO })
      .mockResolvedValueOnce({ data: { revision: 0 } })
      .mockResolvedValueOnce({
        response: { status: 503, headers: new Headers({ 'retry-after': '1' }) },
      })
      .mockResolvedValue({ data: caps(null), response: { status: 200 } });
    await s.connect(mockClient({ GET: get }));
    expect((await s.capabilities()).hwAccel).toBe('vaapi');
    expect(get).toHaveBeenCalledTimes(4);
  });

  it('fails on an unexpected status', async () => {
    const s = svc();
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: HELLO })
      .mockResolvedValueOnce({ data: { revision: 0 } })
      .mockResolvedValue({ response: { status: 500, headers: new Headers() } });
    await s.connect(mockClient({ GET: get }));
    await expect(s.capabilities()).rejects.toThrow('500');
  });

  it('polls until the re-run for the pinned node lands', async () => {
    const s = svc();
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: HELLO })
      .mockResolvedValueOnce({ data: { revision: 0 } })
      .mockResolvedValueOnce({ data: caps('/dev/dri/renderD128') })
      .mockResolvedValueOnce({ data: caps('/dev/dri/renderD128') })
      .mockResolvedValue({ data: caps('/dev/dri/renderD129') });
    await s.connect(mockClient({ GET: get }));
    const out = await s.capabilitiesFor('/dev/dri/renderD129');
    expect(out.defaultGpu).toBe('/dev/dri/renderD129');
    expect(get).toHaveBeenCalledTimes(5);
  });

  it('treats auto as the default node and a GPU-less host as settled', async () => {
    const s = svc();
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: HELLO })
      .mockResolvedValueOnce({ data: { revision: 0 } })
      .mockResolvedValue({ data: caps(null) });
    await s.connect(mockClient({ GET: get }));
    await s.capabilitiesFor('/dev/dri/renderD129');
    expect(get).toHaveBeenCalledTimes(3);
  });
});

describe('EngineService probe', () => {
  it('posts the absolute path and options', async () => {
    const s = svc();
    const post = jest.fn(async () => ({
      data: { ok: true, info: { video: [] } },
      response: {},
    }));
    await s.connect(mockClient({ POST: post }));
    await s.probe('/m/a.mkv', { crop: true });
    expect(post).toHaveBeenCalledWith('/v1/probe', {
      body: { media: { mediaFileId: 0, path: '/m/a.mkv' }, crop: true },
    });
  });

  it('throws on a non-200', async () => {
    const s = svc();
    await s.connect(
      mockClient({
        POST: jest.fn(async () => ({ response: { status: 400 } })),
      }),
    );
    await expect(s.probe('rel.mkv')).rejects.toThrow('400');
  });
});

describe('EngineService host callback', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('defaults the host url to loopback on PORT, FLIKS_HOST_URL wins', () => {
    delete process.env.FLIKS_HOST_URL;
    process.env.PORT = '4849';
    expect(hostUrl()).toBe('http://127.0.0.1:4849');
    process.env.FLIKS_HOST_URL = 'http://nas:4848';
    expect(hostUrl()).toBe('http://nas:4848');
  });

  it('accepts only its own bearer', () => {
    const s = svc();
    expect(s.isHostAuth(`Bearer ${s.hostToken}`)).toBe(true);
    expect(s.isHostAuth(`Bearer ${s.hostToken}x`)).toBe(false);
    expect(s.isHostAuth(undefined)).toBe(false);
    expect(svc().isHostAuth(`Bearer ${s.hostToken}`)).toBe(false);
  });
});

describe('EngineService revoke', () => {
  const withRevoke = (post: jest.Mock, features = [...HELLO.features, 'revoke']) =>
    mockClient({
      GET: jest.fn(async (url: string) =>
        url === '/v1/hello'
          ? { data: { ...HELLO, features }, response: { status: 200 } }
          : { data: { revision: 7 }, response: { status: 200 } },
      ),
      POST: post,
    });

  it('posts the owner when the engine announces revoke', async () => {
    const s = svc();
    const post = jest.fn(async () => ({ response: { ok: true, status: 200 } }));
    await s.connect(withRevoke(post));
    await s.revokeOwner(5);
    expect(post).toHaveBeenCalledWith('/v1/revoke', { body: { ownerId: '5' } });
  });

  it('is a no-op without the feature or without an engine', async () => {
    const post = jest.fn();
    const s = svc();
    await s.revokeOwner(5);
    await s.connect(withRevoke(post, HELLO.features));
    await s.revokeOwner(5);
    expect(post).not.toHaveBeenCalled();
  });

  it('swallows a failing engine', async () => {
    const s = svc();
    await s.connect(
      withRevoke(jest.fn(async () => Promise.reject(new Error('down')))),
    );
    await expect(s.revokeOwner(5)).resolves.toBeUndefined();
  });
});

describe('EngineService runtime', () => {
  const RUNTIME = [...HELLO.features, 'sessions', 'serve', 'events'];
  const hello = (features: string[]) =>
    jest.fn(async (url: string) =>
      url === '/v1/hello'
        ? { data: { ...HELLO, features }, response: { status: 200 } }
        : { data: { revision: 7 }, response: { status: 200 } },
    );
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it.each([
    [RUNTIME, true],
    [HELLO.features, false],
    [[...HELLO.features, 'sessions', 'serve'], false],
    [[...HELLO.features, 'sessions', 'events'], false],
  ])('runs playback only with sessions, serve and events: %j', async (features, runtime) => {
    const s = svc();
    await s.connect(mockClient({ GET: hello(features) }));
    expect(s.enabled).toBe(true);
    expect(s.runtime).toBe(runtime);
  });

  it('is not a runtime before it is adopted, nor once it is refused', async () => {
    const s = svc();
    expect(s.runtime).toBe(false);
    await s.connect(mockClient({ GET: jest.fn(async () => ({ data: { ...HELLO, features: ['sessions', 'serve', 'events'] } })) }));
    expect(s.enabled).toBe(false);
    expect(s.runtime).toBe(false);
  });

  it('exposes the announced features of the adopted engine only', async () => {
    const s = svc();
    expect(s.engineFeatures).toEqual([]);
    await s.connect(mockClient({ GET: hello(RUNTIME) }));
    expect(s.engineFeatures).toEqual(RUNTIME);
  });

  it('reports off, up and down', async () => {
    delete process.env.FLIKS_ENGINE_URL;
    expect(svc().status).toBe('off');
    process.env.FLIKS_ENGINE_URL = 'http://engine';
    const s = svc();
    expect(s.status).toBe('off');
    await s.connect(mockClient({ GET: hello(RUNTIME) }));
    expect(s.status).toBe('up');
    (s as any).sleep = async () => undefined;
    const down = mockClient({ GET: jest.fn().mockRejectedValue(new Error('down')) });
    (s as any).candidate = down;
    await (s as any).tick();
    expect(s.status).toBe('down');
    (s as any).candidate = mockClient({ GET: hello(RUNTIME) });
    await (s as any).tick();
    expect(s.status).toBe('up');
    clearTimeout((s as any).timer);
  });

  describe('session calls', () => {
    async function connected(over: Record<string, jest.Mock> = {}) {
      const s = svc();
      const c = mockClient({ GET: hello(RUNTIME), DELETE: jest.fn(), ...over });
      await s.connect(c);
      return { s, c: c as typeof c & { DELETE: jest.Mock } };
    }
    const reply = (status: number, data?: unknown, headers: Record<string, string> = {}) => ({
      data,
      response: { ok: status < 300, status, headers: new Headers(headers) },
    });

    it('opens a session', async () => {
      const post = jest.fn(async () => reply(200, { sessionId: 'a' }));
      const { s } = await connected({ POST: post });
      await expect(s.openSession({ x: 1 } as never)).resolves.toEqual({ sessionId: 'a' });
      expect(post).toHaveBeenCalledWith('/v1/sessions', { body: { x: 1 } });
    });

    it('waits out the 503 + Retry-After of the first detection run', async () => {
      const post = jest
        .fn()
        .mockResolvedValueOnce(reply(503, undefined, { 'retry-after': '2' }))
        .mockResolvedValueOnce(reply(200, { sessionId: 'a' }));
      const slept: number[] = [];
      const { s } = await connected({ POST: post });
      (s as any).sleep = async (ms: number) => void slept.push(ms);
      await expect(s.openSession({} as never)).resolves.toEqual({ sessionId: 'a' });
      expect(slept).toEqual([2000]);
    });

    it('throws the status of any other refusal', async () => {
      const { s } = await connected({ POST: jest.fn(async () => reply(400)) });
      await expect(s.openSession({} as never)).rejects.toMatchObject({ status: 400 });
    });

    it('heartbeats with the sid as a path parameter, and surfaces another owner as 403', async () => {
      const post = jest
        .fn()
        .mockResolvedValueOnce(reply(200, { sessionLost: false }))
        .mockResolvedValueOnce(reply(403));
      const { s } = await connected({ POST: post });
      await expect(s.heartbeat('a/b', { ownerId: '7', positionS: 3 })).resolves.toEqual({ sessionLost: false });
      expect(post).toHaveBeenCalledWith('/v1/sessions/{sid}/heartbeat', {
        path: { sid: 'a/b' },
        body: { ownerId: '7', positionS: 3 },
      });
      await expect(s.heartbeat('a', {})).rejects.toMatchObject({ status: 403 });
    });

    it('deletes a session with its reason, idempotently', async () => {
      const del = jest.fn(async () => reply(204));
      const { s } = await connected({ DELETE: del });
      await s.deleteSession('a', 'stopped');
      expect(del).toHaveBeenCalledWith('/v1/sessions/{sid}', { path: { sid: 'a' }, query: { reason: 'stopped' } });
    });

    it('lists with filters, and answers null for an unknown session', async () => {
      const get = jest.fn(async (url: string) =>
        url === '/v1/hello' ? { data: { ...HELLO, features: RUNTIME }, response: { status: 200 } }
        : url === '/v1/sessions' ? reply(200, [{ sessionId: 'a' }])
        : url === '/v1/config' ? { data: { revision: 1 }, response: { status: 200 } }
        : reply(404),
      );
      const { s, c } = await connected({ GET: get });
      await expect(s.listSessions({ ownerId: '7' })).resolves.toEqual([{ sessionId: 'a' }]);
      expect(c.GET).toHaveBeenCalledWith('/v1/sessions', { query: { ownerId: '7' } });
      await expect(s.getSession('zz')).resolves.toBeNull();
    });

    it('answers the status of a command', async () => {
      const { s } = await connected({ POST: jest.fn(async () => reply(409)) });
      await expect(s.sessionCommand('a', 'pauseJob')).resolves.toBe(409);
    });

    it('reads and purges the cache', async () => {
      const del = jest.fn(async () => reply(200, { removed: 3 }));
      const { s } = await connected({ DELETE: del });
      await expect(s.purgeCache({ mediaFileId: 4, ownerId: '7' })).resolves.toBe(3);
      expect(del).toHaveBeenCalledWith('/v1/cache', { query: { mediaFileId: 4, ownerId: '7' } });
    });

    it('refuses to call a disabled engine', async () => {
      await expect(svc().openSession({} as never)).rejects.toThrow('The streaming engine is not running');
    });
  });
});
