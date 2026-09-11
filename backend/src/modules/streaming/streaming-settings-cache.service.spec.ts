import { StreamingSettingsCache } from './streaming-settings-cache.service';
import type { SettingsService } from '../settings/settings.service';

/** The tuning settings resolve DB > env > derived default. A saved value must
 *  win over a leftover compose entry, and an absent one must never collapse the
 *  env budget to a hardcoded default. */
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

  it('falls back to the env budget when nothing is saved', async () => {
    process.env.TRANSCODE_CACHE_MAX_BYTES = String(50 * 1024 ** 3);
    process.env.TRANSCODE_CACHE_TTL_MS = String(2 * 3_600_000);
    process.env.TRANSCODE_TONEMAP_CURVE = 'mobius';

    const s = await build().get();
    expect(s.cacheMaxBytes).toBe(50 * 1024 ** 3);
    expect(s.cacheTtlMs).toBe(2 * 3_600_000);
    expect(s.tonemapCurve).toBe('mobius');
    expect(s.ffmpegSlots).toBeNull();
  });

  it('lets a saved value win over the env one', async () => {
    process.env.TRANSCODE_CACHE_MAX_BYTES = String(50 * 1024 ** 3);
    process.env.TRANSCODE_TONEMAP_CURVE = 'mobius';

    const s = await build({
      streaming_cache_max_gb: '10',
      streaming_cache_ttl_hours: '6',
      streaming_tonemap_curve: 'reinhard',
      streaming_ffmpeg_slots: '3',
    }).get();
    expect(s.cacheMaxBytes).toBe(10 * 1024 ** 3);
    expect(s.cacheTtlMs).toBe(6 * 3_600_000);
    expect(s.tonemapCurve).toBe('reinhard');
    expect(s.ffmpegSlots).toBe(3);
  });

  it('folds the env tonemap algo and render node into the resolved value', async () => {
    process.env.TRANSCODE_TONEMAP_ALGO = '  QSV  ';
    process.env.FLIKS_VAAPI_RENDER_NODE = '/dev/dri/renderD129';

    const s = await build().get();
    expect(s.tonemapAlgo).toBe('qsv');
    expect(s.gpuRenderNode).toBe('/dev/dri/renderD129');
  });

  it('lets an explicit algo and node win over the env ones', async () => {
    process.env.TRANSCODE_TONEMAP_ALGO = 'qsv';
    process.env.FLIKS_VAAPI_RENDER_NODE = '/dev/dri/renderD129';

    const s = await build({
      streaming_tonemap_algo: 'opencl',
      streaming_gpu_render_node: '/dev/dri/renderD128',
    }).get();
    expect(s.tonemapAlgo).toBe('opencl');
    expect(s.gpuRenderNode).toBe('/dev/dri/renderD128');
  });

  it('stays on auto when neither the setting nor the env names a value', async () => {
    delete process.env.TRANSCODE_TONEMAP_ALGO;
    delete process.env.FLIKS_VAAPI_RENDER_NODE;

    const s = await build().get();
    expect(s.tonemapAlgo).toBe('auto');
    expect(s.gpuRenderNode).toBe('auto');
  });

  it('ignores a malformed or non-positive saved value', async () => {
    process.env.TRANSCODE_CACHE_MAX_BYTES = String(50 * 1024 ** 3);
    delete process.env.TRANSCODE_TONEMAP_CURVE;

    const s = await build({
      streaming_cache_max_gb: '0',
      streaming_ffmpeg_slots: '-2',
      streaming_tonemap_curve: 'nonsense',
    }).get();
    expect(s.cacheMaxBytes).toBe(50 * 1024 ** 3);
    expect(s.ffmpegSlots).toBeNull();
    expect(s.tonemapCurve).toBe('hable');
  });
});
