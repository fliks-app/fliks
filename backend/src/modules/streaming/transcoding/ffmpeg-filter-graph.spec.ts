import { buildVideoFilters } from './ffmpeg-filter-graph';

const base = {
  crop: undefined,
  burnIn: undefined,
  tonemap: false,
  useVaapiTonemap: false,
  sourceBitDepth: 8,
  scaleWidth: 1920,
  scaleHeight: 1080,
};

describe('buildVideoFilters', () => {
  it('is all-empty for a plain SDR scale (no crop / tonemap / burn-in)', () => {
    expect(buildVideoFilters(base)).toEqual({
      cropStr: '',
      cpuCropPrefix: '',
      hwCropPrefix: '',
      burnInFilter: '',
      tonemapVaapi: '',
      tonemapVulkan: '',
      tonemapOpencl: '',
      tonemapCuda: '',
      tonemapCpu: '',
    });
  });

  it('builds crop strings + a 10-bit HW round-trip for cropped HDR', () => {
    const f = buildVideoFilters({
      ...base,
      crop: { width: 3840, height: 1632, x: 0, y: 264 },
      sourceBitDepth: 10,
    });
    expect(f.cropStr).toBe('crop=3840:1632:0:264');
    expect(f.cpuCropPrefix).toBe('crop=3840:1632:0:264,');
    expect(f.hwCropPrefix).toBe(
      'hwdownload,format=p010le,crop=3840:1632:0:264,hwupload=derive_device=vaapi,',
    );
  });

  it('8-bit crop uses nv12 in the round-trip', () => {
    const f = buildVideoFilters({
      ...base,
      crop: { width: 1920, height: 800, x: 0, y: 140 },
    });
    expect(f.hwCropPrefix).toContain('format=nv12,');
  });

  it('opencl tone-map when tonemap + not vaapi + no burn-in', () => {
    const f = buildVideoFilters({ ...base, tonemap: true });
    expect(f.tonemapOpencl).toContain('tonemap_opencl=');
    expect(f.tonemapOpencl).toContain('apply_dovi=0');
    expect(f.tonemapVaapi).toBe('');
    expect(f.tonemapCpu).toContain('tonemap=hable');
  });

  it('CPU tone-map downscales in linear light, then converts BT.2020 → BT.709', () => {
    const f = buildVideoFilters({ ...base, tonemap: true, scaleWidth: 1280 });
    // Downscale to the output width in linear light first, so the CPU tone
    // curve + gamut conversion run at output res, not the source's; vf_tonemap
    // needs linear light and the chain must convert primaries + transfer.
    expect(f.tonemapCpu).toBe(
      'zscale=w=1280:h=-2:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,' +
        'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL,sidedata=mode=delete:type=DYNAMIC_HDR_PLUS,',
    );
  });

  it('does not append the sidedata strip to tonemapx (verified clean on real HDR10 media)', () => {
    const f = buildVideoFilters({ ...base, tonemap: true, dvNoBase: true });
    expect(f.tonemapCpu).not.toContain('sidedata');
  });

  it('routes the tone-map through tonemap_opencl (GPU) when openclTonemap', () => {
    const f = buildVideoFilters({ ...base, tonemap: true, openclTonemap: true });
    expect(f.tonemapCpu).toBe(
      'format=p010le,hwupload,tonemap_opencl=t=bt709:m=bt709:p=bt709:tonemap=hable:desat=0:apply_dovi=0:format=nv12,hwdownload,format=nv12,',
    );
    // No CPU zscale tone-map when the GPU path is used.
    expect(f.tonemapCpu).not.toContain('zscale');
  });

  it('applies the RPU (apply_dovi=1) on the opencl bounce for a no-base DV source', () => {
    const f = buildVideoFilters({
      ...base,
      tonemap: true,
      openclTonemap: true,
      dvNoBase: true,
    });
    expect(f.tonemapCpu).toContain(':desat=0:apply_dovi=1:format=nv12,');
  });

  it('routes a no-base DV source through tonemapx on the CPU fallback', () => {
    const f = buildVideoFilters({ ...base, tonemap: true, dvNoBase: true });
    expect(f.tonemapCpu).toBe(
      'scale=1920:-2,tonemapx=t=bt709:m=bt709:p=bt709:tonemap=hable:desat=0:format=yuv420p,',
    );
  });

  it('honours the tonemapCurve override', () => {
    const hable = buildVideoFilters({ ...base, tonemap: true });
    const mobius = buildVideoFilters({ ...base, tonemap: true, tonemapCurve: 'mobius' });
    expect(hable.tonemapCpu).toContain('tonemap=tonemap=hable:');
    expect(mobius.tonemapCpu).toContain('tonemap=tonemap=mobius:');
  });

  it('vaapi tone-map when useVaapiTonemap', () => {
    const f = buildVideoFilters({ ...base, tonemap: true, useVaapiTonemap: true });
    expect(f.tonemapVaapi).toContain('tonemap_vaapi=');
    expect(f.tonemapOpencl).toBe('');
  });

  it('vulkan tone-map applies the RPU (apply_dolbyvision=1) for a no-base DV source', () => {
    const f = buildVideoFilters({
      ...base,
      tonemap: true,
      useVulkanTonemap: true,
      dvNoBase: true,
    });
    expect(f.tonemapVulkan).toContain('libplacebo=');
    expect(f.tonemapVulkan).toContain('apply_dolbyvision=1');
    expect(f.tonemapVulkan).toContain('format=vulkan,hwmap=derive_device=vaapi');
  });

  it('burn-in keeps the opencl/vaapi GPU tone-maps (text burn-in stays on the GPU)', () => {
    const f = buildVideoFilters({
      ...base,
      tonemap: true,
      burnIn: { filter: 'subtitles=/tmp/x.ass' } as never,
    });
    expect(f.tonemapOpencl).toContain('tonemap_opencl=');
    expect(f.burnInFilter).toBe(',subtitles=/tmp/x.ass');
    expect(f.tonemapCpu).toContain('tonemap=hable');
  });

  it('burn-in still suppresses vulkan (no-base DV fallback stays CPU-only with burn-in)', () => {
    const f = buildVideoFilters({
      ...base,
      tonemap: true,
      useVulkanTonemap: true,
      dvNoBase: true,
      burnIn: { filter: 'subtitles=/tmp/x.ass' } as never,
    });
    expect(f.tonemapVulkan).toBe('');
  });
});
