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
  it('emits vpp_qsv directly for a qsv-native (Linux) input surface', () => {
    expect(qsvScaleFilter8bit(input({ inputSurface: 'qsv' }))).toBe(
      'vpp_qsv=w=1920:h=804:format=nv12',
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
      'hwmap=derive_device=opencl:mode=read,' +
        'tonemap_opencl=tonemap=hable:t=bt709:m=bt709:p=bt709:format=nv12,' +
        'hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv,' +
        'vpp_qsv=w=1920:h=804:format=nv12',
    );
  });

  it('keeps the zero-copy QSV↔OpenCL chain for a Linux qsv surface', () => {
    expect(
      qsvScaleFilter8bit(
        input({ inputSurface: 'qsv', tonemap: true, tonemapPath: 'opencl' }),
      ),
    ).toBe(
      'vpp_qsv=w=1920:h=804:format=p010le,' +
        'hwmap=derive_device=opencl:mode=read,' +
        'tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,' +
        'hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,' +
        'format=qsv',
    );
  });
});

describe('qsvScaleFilter10bit', () => {
  it('emits vpp_qsv p010le directly for a qsv-native input surface', () => {
    expect(qsvScaleFilter10bit(input({ inputSurface: 'qsv' }))).toBe(
      'vpp_qsv=w=1920:h=804:format=p010le',
    );
  });

  it('maps the d3d11 surface onto QSV before vpp_qsv (p010le)', () => {
    expect(qsvScaleFilter10bit(input({ inputSurface: 'd3d11' }))).toBe(
      'hwmap=derive_device=qsv,vpp_qsv=w=1920:h=804:format=p010le',
    );
  });
});
