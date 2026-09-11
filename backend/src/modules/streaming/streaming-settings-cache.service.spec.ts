import { StreamingSettingsCache } from './streaming-settings-cache.service';
import type { SettingsService } from '../settings/settings.service';

/** The tuning settings come from the database or from a built-in default, never
 *  from the environment: the compose overrides they replaced are retired. */
describe('StreamingSettingsCache tuning resolution', () => {
  const OLD_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  function build(stored: Record<string, string> = {}) {
    const settings = {
      get: (k: string) => Promise.resolve(stored[k] ?? null),
      addChangeListener: () => undefined,
    } as unknown as SettingsService;
    return new StreamingSettingsCache(settings);
  }

  it('falls back to the built-in defaults when nothing is saved', async () => {
    const s = await build().get();
    expect(s.cacheMaxBytes).toBe(20 * 1024 ** 3);
    expect(s.cacheTtlMs).toBe(4 * 3_600_000);
    expect(s.tonemapCurve).toBe('hable');
    expect(s.tonemapAlgo).toBe('auto');
    expect(s.gpuRenderNode).toBe('auto');
    expect(s.ffmpegSlots).toBeNull();
  });

  it('takes every saved value', async () => {
    const s = await build({
      streaming_cache_max_gb: '10',
      streaming_cache_ttl_hours: '6',
      streaming_tonemap_curve: 'reinhard',
      streaming_tonemap_algo: 'opencl',
      streaming_gpu_render_node: '/dev/dri/renderD129',
      streaming_ffmpeg_slots: '3',
    }).get();
    expect(s.cacheMaxBytes).toBe(10 * 1024 ** 3);
    expect(s.cacheTtlMs).toBe(6 * 3_600_000);
    expect(s.tonemapCurve).toBe('reinhard');
    expect(s.tonemapAlgo).toBe('opencl');
    expect(s.gpuRenderNode).toBe('/dev/dri/renderD129');
    expect(s.ffmpegSlots).toBe(3);
  });

  it('ignores a malformed or non-positive saved value', async () => {
    const s = await build({
      streaming_cache_max_gb: '0',
      streaming_ffmpeg_slots: '-2',
      streaming_tonemap_curve: 'nonsense',
      streaming_tonemap_algo: 'nonsense',
    }).get();
    expect(s.cacheMaxBytes).toBe(20 * 1024 ** 3);
    expect(s.ffmpegSlots).toBeNull();
    expect(s.tonemapCurve).toBe('hable');
    expect(s.tonemapAlgo).toBe('auto');
  });

  it('never lets a retired env var reach the resolved settings', async () => {
    process.env.TRANSCODE_TONEMAP_ALGO = 'qsv';
    process.env.TRANSCODE_TONEMAP_CURVE = 'mobius';
    process.env.FLIKS_VAAPI_RENDER_NODE = '/dev/dri/renderD129';
    process.env.TRANSCODE_CACHE_MAX_BYTES = String(50 * 1024 ** 3);
    process.env.TRANSCODE_CACHE_TTL_MS = String(2 * 3_600_000);
    process.env.FLIKS_FFMPEG_SLOTS = '7';

    const s = await build().get();
    expect(s.tonemapAlgo).toBe('auto');
    expect(s.tonemapCurve).toBe('hable');
    expect(s.gpuRenderNode).toBe('auto');
    expect(s.cacheMaxBytes).toBe(20 * 1024 ** 3);
    expect(s.cacheTtlMs).toBe(4 * 3_600_000);
    expect(s.ffmpegSlots).toBeNull();
  });
});
