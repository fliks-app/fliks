import { vaapiScaleFilter8bit } from './vaapi-filters';
import type { EncoderInput } from '../../types';

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
      tonemapVulkan: '',
      tonemapOpencl: '',
      tonemapCuda: '',
      tonemapCpu: '',
    },
    hasBurnIn: false,
    ...over,
  } as unknown as EncoderInput;
}

describe('vaapiScaleFilter8bit text burn-in', () => {
  it('leaves the plain (no tonemap) chain untouched without burn-in', () => {
    expect(vaapiScaleFilter8bit(input({}))).toBe(
      'scale_vaapi=w=1920:h=-2:format=nv12',
    );
  });

  it('bounces to CPU only for subtitles=..., then re-uploads to VAAPI', () => {
    expect(
      vaapiScaleFilter8bit(
        input({
          hasBurnIn: true,
          filters: {
            cropStr: '',
            cpuCropPrefix: '',
            hwCropPrefix: '',
            burnInFilter: ",subtitles='/subs.srt'",
            tonemapVaapi: '',
            tonemapVulkan: '',
            tonemapOpencl: '',
            tonemapCuda: '',
            tonemapCpu: '',
          },
        }),
      ),
    ).toBe(
      'scale_vaapi=w=1920:h=-2:format=nv12,' +
        "hwdownload,format=nv12,subtitles='/subs.srt',hwupload=derive_device=vaapi:extra_hw_frames=16",
    );
  });

  it('pins format=vaapi after tonemap_vaapi before the burn-in bounce', () => {
    // tonemap_vaapi's `format=nv12` is an internal option, not a pixel-format
    // pin, so skipping it breaks ffmpeg 8.1's link renegotiation (verified).
    expect(
      vaapiScaleFilter8bit(
        input({
          hasBurnIn: true,
          filters: {
            cropStr: '',
            cpuCropPrefix: '',
            hwCropPrefix: '',
            burnInFilter: ",subtitles='/subs.srt'",
            tonemapVaapi: ',tonemap_vaapi=format=nv12:t=bt709:p=bt709:m=bt709',
            tonemapVulkan: '',
            tonemapOpencl: '',
            tonemapCuda: '',
            tonemapCpu: '',
          },
        }),
      ),
    ).toBe(
      'scale_vaapi=w=1920:h=-2:extra_hw_frames=24,tonemap_vaapi=format=nv12:t=bt709:p=bt709:m=bt709,format=vaapi,' +
        "hwdownload,format=nv12,subtitles='/subs.srt',hwupload=derive_device=vaapi:extra_hw_frames=16",
    );
  });

  it('keeps the opencl round-trip chain and appends the burn-in bounce after it', () => {
    expect(
      vaapiScaleFilter8bit(
        input({
          hasBurnIn: true,
          filters: {
            cropStr: '',
            cpuCropPrefix: '',
            hwCropPrefix: '',
            burnInFilter: ",subtitles='/subs.srt'",
            tonemapVaapi: '',
            tonemapVulkan: '',
            tonemapOpencl:
              ',hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=hable:desat=0:apply_dovi=0',
            tonemapCuda: '',
            tonemapCpu: '',
          },
        }),
      ),
    ).toBe(
      'scale_vaapi=w=1920:h=-2:extra_hw_frames=24,hwmap=derive_device=opencl:mode=read,' +
        'tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=hable:desat=0:apply_dovi=0,' +
        'hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi,' +
        "hwdownload,format=nv12,subtitles='/subs.srt',hwupload=derive_device=vaapi:extra_hw_frames=16",
    );
  });
});
