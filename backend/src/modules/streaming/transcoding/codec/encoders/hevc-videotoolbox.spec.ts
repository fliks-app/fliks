import { hevcVideotoolboxHdr10, hevcVideotoolboxHlg } from './hevc-videotoolbox';
import { buildVideoFilters } from '../../ffmpeg-filter-graph';
import { encoderRegistry } from './index';
import type { EncoderInput } from '../types';

function makeInput(hasBurnIn: boolean): EncoderInput {
  const burnIn = hasBurnIn
    ? { type: 'text' as const, filter: "subtitles='/sub.srt'" }
    : undefined;
  return {
    variant: { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' },
    target: {
      width: 1920,
      height: 1080,
      videoBitrateBps: 8_000_000,
      gopSize: 72,
      frameRate: 24,
    },
    preset: 'fast',
    nvencPreset: 'p4',
    seekSeconds: 0,
    early: false,
    forceKeyframesExpr: 'expr:gte(t,0)',
    qsv: { extra: [], rcInitOccupancy: 0, bufsize: 0 },
    libx264BufsizeMb: '16M',
    filters: buildVideoFilters({
      burnIn,
      tonemap: false,
      useVaapiTonemap: false,
      sourceBitDepth: 10,
      dvApplyRpu: false,
      scaleWidth: 1920,
    }),
    tonemap: false,
    tonemapPath: 'opencl',
    dvApplyRpu: false,
    hasBurnIn,
    hasCrop: false,
    inputSurface: 'cpu',
  };
}

describe('hevc_videotoolbox HDR10/HLG', () => {
  it('reports HDR metadata support (VideoToolbox carries mdcv/clli through from AVFrame side data)', () => {
    expect(hevcVideotoolboxHdr10.supportsHdrMetadata()).toBe(true);
    expect(hevcVideotoolboxHlg.supportsHdrMetadata()).toBe(true);
  });

  it('encodes Main10 p010le with BT.2020/PQ tags', () => {
    const args = hevcVideotoolboxHdr10.buildArgs(makeInput(false));
    expect(args).toEqual(
      expect.arrayContaining([
        '-profile:v',
        'main10',
        '-pix_fmt',
        'p010le',
        '-color_primaries',
        'bt2020',
        '-color_trc',
        'smpte2084',
      ]),
    );
  });

  it('HLG variant swaps the transfer tag only', () => {
    const args = hevcVideotoolboxHlg.buildArgs(makeInput(false));
    expect(args).toEqual(expect.arrayContaining(['-color_trc', 'arib-std-b67']));
  });

  it('appends the burn-in filter to the -vf chain', () => {
    const args = hevcVideotoolboxHdr10.buildArgs(makeInput(true));
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf.endsWith(",subtitles='/sub.srt'")).toBe(true);
  });

  it('uses scale_vt on the Metal surface for HDR passthrough (no crop, no burn-in)', () => {
    const input = { ...makeInput(false), inputSurface: 'videotoolbox' as const };
    const args = hevcVideotoolboxHdr10.buildArgs(input);
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf).toBe('scale_vt=w=1920:h=-2');
  });

  it('registry resolves the HDR10 HEVC/videotoolbox variant to the VT encoder, not a CPU fallback', () => {
    const enc = encoderRegistry.resolve(
      { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' },
      'videotoolbox',
    );
    expect(enc?.id).toBe('hevc_videotoolbox_main10');
  });
});
