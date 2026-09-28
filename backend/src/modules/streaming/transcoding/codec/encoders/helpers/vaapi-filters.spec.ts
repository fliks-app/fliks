import { vaapiScaleFilter8bit, vaapiScaleFilter10bit } from './vaapi-filters';
import type { EncoderInput } from '../../types';

const BASE_FILTERS = {
  cropStr: '',
  cpuCropPrefix: '',
  hwCropPrefix: '',
  burnInFilter: '',
  tonemapVaapi: '',
  tonemapVulkan: '',
  tonemapOpencl: '',
  tonemapCuda: '',
  tonemapCpu: '',
};

function input(
  filters: Partial<typeof BASE_FILTERS> = {},
  over: Partial<EncoderInput> = {},
): EncoderInput {
  return {
    target: {
      width: 1920,
      height: 804,
      videoBitrateBps: 0,
      gopSize: 0,
      frameRate: 24,
    },
    filters: { ...BASE_FILTERS, ...filters },
    hasBurnIn: false,
    ...over,
  } as unknown as EncoderInput;
}

const BURN_IN_TAIL =
  "hwdownload,format=nv12,subtitles='/subs.srt',hwupload=derive_device=vaapi:extra_hw_frames=16";

describe('vaapiScaleFilter8bit text burn-in', () => {
  it('leaves the plain (no tonemap) chain untouched without burn-in', () => {
    expect(vaapiScaleFilter8bit(input())).toBe(
      'scale_vaapi=w=1920:h=-2:format=nv12',
    );
  });

  it('bounces to CPU only for subtitles=..., then re-uploads to VAAPI', () => {
    expect(
      vaapiScaleFilter8bit(
        input(
          { burnInFilter: ",subtitles='/subs.srt'" },
          { hasBurnIn: true },
        ),
      ),
    ).toBe(`scale_vaapi=w=1920:h=-2:format=nv12,${BURN_IN_TAIL}`);
  });

  it('appends the burn-in bounce after tonemap_vaapi', () => {
    expect(
      vaapiScaleFilter8bit(
        input(
          {
            burnInFilter: ",subtitles='/subs.srt'",
            tonemapVaapi: ',tonemap_vaapi=format=nv12:t=bt709:p=bt709:m=bt709',
          },
          { hasBurnIn: true },
        ),
      ),
    ).toBe(
      'scale_vaapi=w=1920:h=-2:extra_hw_frames=24,tonemap_vaapi=format=nv12:t=bt709:p=bt709:m=bt709,' +
        BURN_IN_TAIL,
    );
  });

  it('keeps the opencl round-trip chain and appends the burn-in bounce after it', () => {
    expect(
      vaapiScaleFilter8bit(
        input(
          {
            burnInFilter: ",subtitles='/subs.srt'",
            tonemapOpencl:
              ',hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=hable:desat=0:apply_dovi=0',
          },
          { hasBurnIn: true },
        ),
      ),
    ).toBe(
      'scale_vaapi=w=1920:h=-2:extra_hw_frames=24,hwmap=derive_device=opencl:mode=read,' +
        'tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=hable:desat=0:apply_dovi=0,' +
        `hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi,${BURN_IN_TAIL}`,
    );
  });
});

describe('vaapiScaleFilter10bit text burn-in', () => {
  it('leaves the plain HDR chain untouched without burn-in', () => {
    expect(vaapiScaleFilter10bit(input())).toBe(
      'scale_vaapi=w=1920:h=-2:format=p010le',
    );
  });

  it('bounces to CPU for text burn-in on a Main10 HDR chain, then re-uploads', () => {
    expect(
      vaapiScaleFilter10bit(
        input(
          { burnInFilter: ",subtitles='/subs.srt'" },
          { hasBurnIn: true },
        ),
      ),
    ).toBe(
      'scale_vaapi=w=1920:h=-2:format=p010le,' +
        "hwdownload,format=p010le,subtitles='/subs.srt',hwupload=derive_device=vaapi:extra_hw_frames=16",
    );
  });
});
