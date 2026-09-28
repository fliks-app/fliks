import { qsvScaleFilter8bit, qsvScaleFilter10bit } from './qsv-filters';
import type { EncoderInput } from '../../types';

/** Minimal EncoderInput for the QSV vpp filter builders — only the fields they
 *  read (target / filters / tonemap / inputSurface). */
function input(over: Partial<EncoderInput>): EncoderInput {
  return {
    target: {
      width: 1920,
      height: 804,
      videoBitrateBps: 0,
      gopSize: 0,
      frameRate: 24,
    },
    filters: {
      cropStr: '',
      cpuCropPrefix: '',
      hwCropPrefix: '',
      burnInFilter: '',
      tonemapVaapi: '',
      tonemapOpencl: '',
      tonemapCpu: '',
    },
    tonemap: false,
    tonemapPath: 'qsv',
    hasCrop: false,
    inputSurface: 'qsv',
    ...over,
  } as unknown as EncoderInput;
}

describe('qsvScaleFilter8bit', () => {
  it('hwmaps onto QSV before vpp_qsv for a qsv-native (Linux) input surface', () => {
    expect(qsvScaleFilter8bit(input({ inputSurface: 'qsv' }))).toBe(
      'hwmap=derive_device=qsv,vpp_qsv=w=1920:h=804:format=nv12',
    );
  });

  it('maps the d3d11 (Windows) surface onto QSV before vpp_qsv', () => {
    expect(qsvScaleFilter8bit(input({ inputSurface: 'd3d11' }))).toBe(
      'hwmap=derive_device=qsv,vpp_qsv=w=1920:h=804:format=nv12',
    );
  });

  it('keeps the vpp_qsv LUT tonemap on the mapped d3d11 path', () => {
    expect(
      qsvScaleFilter8bit(
        input({ inputSurface: 'd3d11', tonemap: true, tonemapPath: 'qsv' }),
      ),
    ).toBe('hwmap=derive_device=qsv,vpp_qsv=tonemap=1:w=1920:h=804:format=nv12');
  });

  it('tone-maps a Windows d3d11 surface zero-copy through OpenCL', () => {
    expect(
      qsvScaleFilter8bit(
        input({ inputSurface: 'd3d11', tonemap: true, tonemapPath: 'opencl' }),
      ),
    ).toBe(
      'hwmap=derive_device=qsv,' +
        'vpp_qsv=w=1920:h=804:format=p010le,' +
        'hwmap=derive_device=opencl,' +
        'tonemap_opencl=tonemap=hable:t=bt709:m=bt709:p=bt709:format=nv12:apply_dovi=0,' +
        'hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv',
    );
  });

  it('sets apply_dovi=1 on the d3d11 OpenCL chain for a no-base DV source', () => {
    expect(
      qsvScaleFilter8bit(
        input({
          inputSurface: 'd3d11',
          tonemap: true,
          tonemapPath: 'opencl',
          dvNoBase: true,
        }),
      ),
    ).toContain(':format=nv12:apply_dovi=1,');
  });

  it('keeps the zero-copy QSV↔OpenCL chain for a Linux qsv surface', () => {
    expect(
      qsvScaleFilter8bit(
        input({ inputSurface: 'qsv', tonemap: true, tonemapPath: 'opencl' }),
      ),
    ).toBe(
      'hwmap=derive_device=qsv,' +
        'vpp_qsv=w=1920:h=804:format=p010le,' +
        'hwmap=derive_device=opencl:mode=read,' +
        'tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=hable:desat=0:apply_dovi=0,' +
        'hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,' +
        'format=qsv',
    );
  });

  it('sets apply_dovi=1 on the Linux OpenCL chain for a no-base DV source', () => {
    expect(
      qsvScaleFilter8bit(
        input({
          inputSurface: 'qsv',
          tonemap: true,
          tonemapPath: 'opencl',
          dvNoBase: true,
        }),
      ),
    ).toContain(':desat=0:apply_dovi=1,');
  });

  it('honours the configured curve on the d3d11 OpenCL chain', () => {
    expect(
      qsvScaleFilter8bit(
        input({
          inputSurface: 'd3d11',
          tonemap: true,
          tonemapPath: 'opencl',
          tonemapCurve: 'mobius',
        }),
      ),
    ).toContain('tonemap_opencl=tonemap=mobius:');
  });

  it('honours the configured curve on the Linux OpenCL chain', () => {
    expect(
      qsvScaleFilter8bit(
        input({
          inputSurface: 'qsv',
          tonemap: true,
          tonemapPath: 'opencl',
          tonemapCurve: 'reinhard',
        }),
      ),
    ).toContain(':tonemap=reinhard:desat=0');
  });

  it('uploads to VAAPI (not the default QSV filter device) for a CPU-decoded source', () => {
    // A bare hwupload would target `-filter_hw_device qs` (QSV, set for
    // burn-in) instead of VAAPI, which scale_vaapi then rejects.
    expect(qsvScaleFilter8bit(input({ inputSurface: 'cpu' }))).toBe(
      'format=nv12,hwupload=derive_device=vaapi,' +
        'scale_vaapi=w=1920:h=-2:format=nv12:extra_hw_frames=24,' +
        'hwmap=derive_device=qsv,format=qsv',
    );
  });

  it('renders target.height on a crop, not its own aspect-ratio rounding', () => {
    // target.height (534) is what profileResolution/buildOutputDimensions
    // computed for this crop; re-deriving it from cw/ch here rounded to 532.
    expect(
      qsvScaleFilter8bit(
        input({
          inputSurface: 'qsv',
          hasCrop: true,
          target: {
            width: 1280,
            height: 534,
            videoBitrateBps: 0,
            gopSize: 0,
            frameRate: 24,
          },
          filters: {
            cropStr: 'crop=1921:800:0:0',
            cpuCropPrefix: '',
            hwCropPrefix: '',
            burnInFilter: '',
            tonemapVaapi: '',
            tonemapOpencl: '',
            tonemapCpu: '',
          },
        }),
      ),
    ).toBe(
      'hwmap=derive_device=qsv,vpp_qsv=cw=1921:ch=800:cx=0:cy=0:w=1280:h=534:format=nv12',
    );
  });

  it('re-renders through vpp_qsv (passthrough off) after tonemap_vaapi on a vaapi surface', () => {
    expect(
      qsvScaleFilter8bit(
        input({
          inputSurface: 'vaapi',
          hasCrop: true,
          filters: {
            cropStr: 'crop=1920:800:0:140',
            cpuCropPrefix: '',
            hwCropPrefix:
              'hwdownload,format=p010le,crop=1920:800:0:140,hwupload=derive_device=vaapi,',
            burnInFilter: '',
            tonemapVaapi: ',tonemap_vaapi=format=nv12:t=bt709:p=bt709:m=bt709',
            tonemapOpencl: '',
            tonemapCpu: '',
          },
        }),
      ),
    ).toBe(
      'hwdownload,format=p010le,crop=1920:800:0:140,hwupload=derive_device=vaapi,' +
        'scale_vaapi=w=1920:h=-2:extra_hw_frames=24,tonemap_vaapi=format=nv12:t=bt709:p=bt709:m=bt709,' +
        'hwmap=derive_device=qsv,vpp_qsv=format=nv12:passthrough=0',
    );
  });
});

describe('qsvScaleFilter10bit', () => {
  it('hwmaps onto QSV before vpp_qsv p010le for a qsv-native input surface', () => {
    expect(qsvScaleFilter10bit(input({ inputSurface: 'qsv' }))).toBe(
      'hwmap=derive_device=qsv,vpp_qsv=w=1920:h=804:format=p010le',
    );
  });

  it('maps the d3d11 surface onto QSV before vpp_qsv (p010le)', () => {
    expect(qsvScaleFilter10bit(input({ inputSurface: 'd3d11' }))).toBe(
      'hwmap=derive_device=qsv,vpp_qsv=w=1920:h=804:format=p010le',
    );
  });

  it('renders target.height on a crop, not its own aspect-ratio rounding', () => {
    expect(
      qsvScaleFilter10bit(
        input({
          inputSurface: 'qsv',
          hasCrop: true,
          target: {
            width: 1280,
            height: 534,
            videoBitrateBps: 0,
            gopSize: 0,
            frameRate: 24,
          },
          filters: {
            cropStr: 'crop=1921:800:0:0',
            cpuCropPrefix: '',
            hwCropPrefix: '',
            burnInFilter: '',
            tonemapVaapi: '',
            tonemapOpencl: '',
            tonemapCpu: '',
          },
        }),
      ),
    ).toBe(
      'hwmap=derive_device=qsv,vpp_qsv=cw=1921:ch=800:cx=0:cy=0:w=1280:h=534:format=p010le',
    );
  });
});
