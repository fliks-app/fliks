import { h264Amf } from './h264-amf';
import { hevcAmf, hevcAmfHdr10, hevcAmfHlg } from './hevc-amf';
import { av1Amf, av1AmfHdr10, av1AmfHlg } from './av1-amf';
import { buildVideoFilters } from '../../ffmpeg-filter-graph';
import type { EncoderDescriptor, EncoderInput } from '../types';
import type { SurfaceFormat } from '../decoders/types';

const CROP = { width: 3840, height: 1632, x: 0, y: 264 };

function makeInput(cfg: {
  inputSurface?: SurfaceFormat;
  tonemap?: boolean;
  crop?: boolean;
}): EncoderInput {
  const tonemap = cfg.tonemap ?? false;
  const crop = cfg.crop ? CROP : undefined;
  return {
    variant: { codec: 'hevc', bitDepth: 8, hdr: null },
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
      crop,
      tonemap,
      useVaapiTonemap: false,
      sourceBitDepth: tonemap ? 10 : 8,
      scaleWidth: 1920,
    }),
    tonemap,
    tonemapPath: 'opencl',
    hasBurnIn: false,
    hasCrop: !!crop,
    inputSurface: cfg.inputSurface ?? 'cpu',
  };
}

function vfOf(args: string[]): string {
  const i = args.indexOf('-vf');
  if (i === -1) throw new Error('no -vf in args');
  return args[i + 1];
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const SDR: [string, EncoderDescriptor][] = [
  ['h264_amf', h264Amf],
  ['hevc_amf', hevcAmf],
  ['av1_amf', av1Amf],
];

const HDR: [string, EncoderDescriptor][] = [
  ['hevc_amf_main10', hevcAmfHdr10],
  ['hevc_amf_hlg', hevcAmfHlg],
  ['av1_amf_hdr10', av1AmfHdr10],
  ['av1_amf_hlg', av1AmfHlg],
];

describe('AMF encoders', () => {
  it('are Windows-only', () => {
    for (const [, enc] of [...SDR, ...HDR]) {
      expect(typeof enc.supports).toBe('function');
    }
    // supports() reads process.platform; on this (non-win32) host it is false.
    if (process.platform !== 'win32') {
      for (const [, enc] of [...SDR, ...HDR]) {
        expect(enc.supports()).toBe(false);
      }
    }
  });

  describe.each(SDR)('%s (SDR)', (id, enc) => {
    it('emits the AMF encoder with a CBR cap', () => {
      const args = enc.buildArgs(makeInput({}));
      expect(flag(args, '-c:v')).toBe(id);
      expect(flag(args, '-rc')).toBe('cbr');
      expect(flag(args, '-b:v')).toBe('8000000');
      expect(flag(args, '-maxrate')).toBe('8000000');
      expect(flag(args, '-force_key_frames')).toBe('expr:gte(t,0)');
      expect(flag(args, '-g')).toBe('72');
    });

    it('scales on CPU (no scale_vaapi / scale_cuda) to nv12', () => {
      const vf = vfOf(enc.buildArgs(makeInput({})));
      expect(vf).toContain('scale=1920:');
      expect(vf).toContain('format=nv12');
      expect(vf).not.toContain('scale_vaapi');
      expect(vf).not.toContain('scale_cuda');
      expect(vf).not.toContain('hwdownload');
    });

    it('scales on the D3D11 device (full-GPU) for d3d11 input', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ inputSurface: 'd3d11' })));
      expect(vf).toBe('scale_d3d11=1920:1080');
    });

    it('pulls non-CPU surfaces down before the CPU scale', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ inputSurface: 'cuda' })));
      expect(vf.startsWith('hwdownload,format=nv12,')).toBe(true);
    });

    it('applies the CPU tonemap chain when tonemapping', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ tonemap: true })));
      expect(vf).toContain('tonemap');
    });

    it('crops via the CPU crop prefix', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ crop: true })));
      expect(vf).toContain('crop=');
    });
  });

  describe('closed-GOP flags', () => {
    it('forces IDR + drops B-frames on h264/hevc', () => {
      for (const enc of [h264Amf, hevcAmf, hevcAmfHdr10]) {
        const args = enc.buildArgs(makeInput({ tonemap: enc !== h264Amf }));
        expect(flag(args, '-forced_idr')).toBe('1');
        expect(flag(args, '-bf')).toBe('0');
      }
    });

    it('omits -forced_idr on av1_amf (unsupported option)', () => {
      const args = av1Amf.buildArgs(makeInput({}));
      expect(args).not.toContain('-forced_idr');
      expect(flag(args, '-bf')).toBe('0');
    });
  });

  describe.each(HDR)('%s (HDR)', (id, enc) => {
    it('encodes p010le with BT.2020 primaries', () => {
      const args = enc.buildArgs(makeInput({}));
      expect(flag(args, '-c:v')).toBe(id.startsWith('hevc') ? 'hevc_amf' : 'av1_amf');
      expect(flag(args, '-pix_fmt')).toBe('p010le');
      expect(flag(args, '-color_primaries')).toBe('bt2020');
      expect(vfOf(args)).toContain('format=p010le');
    });

    it('sets the transfer tag per HDR flavour', () => {
      const trc = flag(enc.buildArgs(makeInput({})), '-color_trc');
      expect(trc).toBe(id.endsWith('hlg') ? 'arib-std-b67' : 'smpte2084');
    });

    it('advertises HDR metadata support', () => {
      expect(enc.supportsHdrMetadata()).toBe(true);
    });
  });

  it('tags HEVC output as hvc1', () => {
    for (const enc of [hevcAmf, hevcAmfHdr10, hevcAmfHlg]) {
      expect(flag(enc.buildArgs(makeInput({})), '-tag:v')).toBe('hvc1');
    }
  });
});
