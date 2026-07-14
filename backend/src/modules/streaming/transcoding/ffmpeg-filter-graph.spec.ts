import { buildVideoFilters } from './ffmpeg-filter-graph';

const base = {
  crop: undefined,
  burnIn: undefined,
  tonemap: false,
  useVaapiTonemap: false,
  sourceBitDepth: 8,
};

describe('buildVideoFilters', () => {
  it('is all-empty for a plain SDR scale (no crop / tonemap / burn-in)', () => {
    expect(buildVideoFilters(base)).toEqual({
      cropStr: '',
      cpuCropPrefix: '',
      hwCropPrefix: '',
      burnInFilter: '',
      tonemapVaapi: '',
      tonemapOpencl: '',
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
    expect(f.tonemapVaapi).toBe('');
    expect(f.tonemapCpu).toContain('tonemap=hable');
  });

  it('CPU tone-map linearises then converts BT.2020 → BT.709 (not a bare tonemap)', () => {
    const f = buildVideoFilters({ ...base, tonemap: true });
    // vf_tonemap needs linear light; the chain must linearise first and
    // convert primaries + output transfer, or the picture washes out grey.
    expect(f.tonemapCpu).toBe(
      'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,',
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

  it('burn-in forces CPU tone-map (HW tone-maps suppressed)', () => {
    const f = buildVideoFilters({
      ...base,
      tonemap: true,
      burnIn: { filter: 'subtitles=/tmp/x.ass' } as never,
    });
    expect(f.tonemapOpencl).toBe('');
    expect(f.tonemapVaapi).toBe('');
    expect(f.burnInFilter).toBe(',subtitles=/tmp/x.ass');
    expect(f.tonemapCpu).toContain('tonemap=hable');
  });

  it('dovi swaps only the CPU tone-map slot for the libplacebo chain', () => {
    const plain = buildVideoFilters({ ...base, tonemap: true });
    const dv = buildVideoFilters({ ...base, tonemap: true, dovi: true });
    expect(dv.tonemapCpu).toContain('libplacebo=apply_dolbyvision=1');
    expect(dv.tonemapCpu).not.toContain('tonemap=tonemap=hable');
    // Every other slot is identical to the non-dovi tone-map.
    for (const k of [
      'cropStr', 'cpuCropPrefix', 'hwCropPrefix',
      'burnInFilter', 'tonemapVaapi', 'tonemapOpencl',
    ] as const) {
      expect(dv[k]).toBe(plain[k]);
    }
  });
});
