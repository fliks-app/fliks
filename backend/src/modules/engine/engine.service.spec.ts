import {
  EngineService,
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
        hostUrl: null,
        hostToken: null,
        streaming: toEngineStreaming(settings),
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
